// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

/// @notice Raised when calldata generated from a production quote cannot execute on the mainnet fork.
error ProductionQuoteSwapFailed(string name, bytes reason);

/// @title ProductionQuotesIntegration
/// @notice Fetches production quotes through the local SDK and executes them against canonical mainnet Core.
contract ProductionQuotesIntegration is Script, StdCheats {
    address payable private constant CORE = payable(0x00000000000014aA86C5d3c41765bb24e11bd701);
    address private constant NATIVE = address(0);
    address private constant CALLER = 0x000000000000000000000000000000000000bEEF;

    struct QuoteCase {
        string name;
        address inputToken;
        address outputToken;
        int256 specifiedAmount;
        int256 quotedCalculated;
        int256 threshold;
        bytes data;
    }

    function run() external {
        require(block.chainid == 1, "mainnet fork required");
        require(CORE.code.length != 0, "canonical Core is not deployed");

        address router = _deployRouter();
        QuoteCase[] memory cases = _productionQuoteCases();
        require(cases.length >= 4, "not enough production quote cases");

        for (uint256 i = 0; i < cases.length; i++) {
            _execute(router, cases[i]);
        }
    }

    function _execute(address router, QuoteCase memory quote) private {
        bool exactOutput = quote.specifiedAmount < 0;
        require((quote.quotedCalculated < 0) == exactOutput, "quote sign mismatch");
        require((quote.threshold < 0) == exactOutput, "threshold sign mismatch");

        uint256 fundedInput = exactOutput ? uint256(-quote.threshold) : uint256(quote.specifiedAmount);
        if (quote.inputToken == NATIVE) {
            deal(CALLER, fundedInput);
        } else {
            deal(quote.inputToken, CALLER, fundedInput);
            vm.prank(CALLER);
            IERC20(quote.inputToken).approve(router, fundedInput);
        }

        uint256 inputBefore = _balance(quote.inputToken);
        uint256 outputBefore = _balance(quote.outputToken);
        uint256 callValue = quote.inputToken == NATIVE ? fundedInput : 0;

        vm.prank(CALLER);
        (bool success, bytes memory returndata) = router.call{value: callValue}(quote.data);
        if (!success) revert ProductionQuoteSwapFailed(quote.name, returndata);

        int256 calculatedAmount = abi.decode(returndata, (int256));
        uint256 inputSpent = inputBefore - _balance(quote.inputToken);
        uint256 outputReceived = _balance(quote.outputToken) - outputBefore;

        if (exactOutput) {
            require(calculatedAmount < 0, "exact-output result sign");
            require(inputSpent == uint256(-calculatedAmount), "exact-output input spent");
            require(inputSpent <= fundedInput, "exact-output maximum input");
            require(outputReceived == uint256(-quote.specifiedAmount), "exact output not received");
        } else {
            require(calculatedAmount > 0, "exact-input result sign");
            require(inputSpent == uint256(quote.specifiedAmount), "exact input not spent");
            require(outputReceived == uint256(calculatedAmount), "exact-input output received");
        }

        console2.log("production quote executed", quote.name);
        console2.log("input spent", inputSpent);
        console2.log("output received", outputReceived);
    }

    function _balance(address token) private view returns (uint256) {
        return token == NATIVE ? CALLER.balance : IERC20(token).balanceOf(CALLER);
    }

    function _deployRouter() private returns (address deployed) {
        bytes memory initcode = vm.parseJsonBytes(vm.readFile("out/YulRouter.yul/YulRouter.json"), ".bytecode.object");
        bytes memory code = bytes.concat(initcode, abi.encode(CORE));

        assembly ("memory-safe") {
            deployed := create(0, add(code, 0x20), mload(code))
        }
        require(deployed != address(0), "router deployment failed");
    }

    function _productionQuoteCases() private returns (QuoteCase[] memory cases) {
        string[] memory command = new string[](2);
        command[0] = "bun";
        command[1] = "sdk/scripts/generate-production-quotes.mjs";
        cases = abi.decode(vm.ffi(command), (QuoteCase[]));
    }
}
