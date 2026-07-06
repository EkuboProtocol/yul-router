// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";

/// @title DeployYulRouter
/// @notice Deploys the Yul router configured for the canonical Ekubo Core address.
contract DeployYulRouter is Script {
    address payable public constant CANONICAL_CORE = payable(0x00000000000014aA86C5d3c41765bb24e11bd701);

    function run() external returns (address router) {
        bytes memory initcode = vm.parseJsonBytes(vm.readFile("out/YulRouter.yul/YulRouter.json"), ".bytecode.object");
        bytes memory code = bytes.concat(initcode, abi.encode(CANONICAL_CORE));

        vm.startBroadcast();
        assembly ("memory-safe") {
            router := create(0, add(code, 0x20), mload(code))
        }
        vm.stopBroadcast();

        require(router != address(0), "YulRouter deploy failed");
    }
}
