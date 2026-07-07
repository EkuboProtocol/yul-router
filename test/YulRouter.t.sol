// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {Core} from "ekubo/Core.sol";
import {Positions} from "ekubo/Positions.sol";
import {TokenWrapper} from "ekubo/TokenWrapper.sol";
import {Ve33} from "ekubo/extensions/Ve33.sol";
import {ICore} from "ekubo/interfaces/ICore.sol";
import {IFlashAccountant} from "ekubo/interfaces/IFlashAccountant.sol";
import {Locker} from "ekubo/types/locker.sol";
import {PoolConfig} from "ekubo/types/poolConfig.sol";
import {PoolKey} from "ekubo/types/poolKey.sol";
import {Test} from "forge-std/Test.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {ERC20} from "solady/tokens/ERC20.sol";

contract TestToken is ERC20 {
    function name() public view override returns (string memory) {
        return "Test Token";
    }

    function symbol() public view override returns (string memory) {
        return "TEST";
    }
}

contract DelegateCaller {
    function delegate(address target, bytes calldata data) external returns (bytes memory result) {
        (bool success, bytes memory returndata) = target.delegatecall(data);
        if (!success) {
            assembly ("memory-safe") {
                revert(add(returndata, 0x20), mload(returndata))
            }
        }
        return returndata;
    }
}

contract SwapForwardee {
    ICore private immutable CORE;

    constructor(ICore core) {
        CORE = core;
    }

    function forwarded_2374103877(Locker) external returns (bytes32 update) {
        (bool success, bytes memory returndata) =
            address(CORE).call(bytes.concat(ICore.swap_6269342730.selector, msg.data[36:]));
        if (!success) {
            assembly ("memory-safe") {
                revert(add(returndata, 0x20), mload(returndata))
            }
        }

        return abi.decode(returndata, (bytes32));
    }
}

contract DebtForwardee {
    ICore private immutable CORE;
    address private immutable debtToken;
    uint128 private immutable amountIn;
    uint128 private immutable amountOut;

    constructor(ICore core, address debtToken_, uint128 amountIn_, uint128 amountOut_) {
        CORE = core;
        debtToken = debtToken_;
        amountIn = amountIn_;
        amountOut = amountOut_;
    }

    function forwarded_2374103877(Locker) external returns (bytes32 update) {
        (bool success, bytes memory returndata) = address(CORE)
            .call(
                abi.encodePacked(
                    IFlashAccountant.withdraw.selector, bytes20(debtToken), bytes20(address(this)), bytes16(uint128(1))
                )
            );
        if (!success) {
            assembly ("memory-safe") {
                revert(add(returndata, 0x20), mload(returndata))
            }
        }

        return _poolBalanceUpdate(int128(amountIn), -int128(amountOut));
    }

    function _poolBalanceUpdate(int128 delta0, int128 delta1) private pure returns (bytes32) {
        return bytes32((uint256(_encodeInt128(delta0)) << 128) | _encodeInt128(delta1));
    }

    function _encodeInt128(int128 value) private pure returns (uint128 encoded) {
        assembly ("memory-safe") {
            encoded := value
        }
    }
}

contract YulRouterTest is Test {
    error DelegateCall();
    error ForwardNotAllowed();
    error InvalidCaller();
    error InvalidRoute();
    error SlippageCheckFailed(int256);

    address payable private constant CORE_ADDRESS = payable(0x00000000000014aA86C5d3c41765bb24e11bd701);
    address private constant TOKEN0 = 0x1111111111111111111111111111111111111111;
    address private constant TOKEN1 = 0x2222222222222222222222222222222222222222;
    address private constant TOKEN2 = 0x4444444444444444444444444444444444444444;
    address private constant WRAPPED_TOKEN0 = 0x3333333333333333333333333333333333333333;
    address private constant VE33 = 0xd100000000000000000000000000000000000000;

    uint128 private constant POSITION_AMOUNT = 100_000 ether;
    uint128 private constant SWAP_AMOUNT = 1 ether;
    uint64 private constant FEE = 92_233_720_368_547;
    uint32 private constant VE33_TICK_SPACING = 1024;

    ICore private constant CORE = ICore(CORE_ADDRESS);

    Positions private positions;
    address private router;
    address private forwardTarget;

    struct SdkCases {
        bytes core;
        bytes wrapper;
        bytes ve33;
        bytes multiMultiHop;
    }

    function setUp() public {
        deployCodeTo("Core.sol:Core", CORE_ADDRESS);
        deployCodeTo("Ve33.sol:Ve33", abi.encode(CORE_ADDRESS, TOKEN0), VE33);
        deployCodeTo("TokenWrapper.sol:TokenWrapper", abi.encode(CORE, TOKEN0, block.timestamp), WRAPPED_TOKEN0);
        deployCodeTo("YulRouter.t.sol:TestToken", TOKEN0);
        deployCodeTo("YulRouter.t.sol:TestToken", TOKEN1);
        deployCodeTo("YulRouter.t.sol:TestToken", TOKEN2);

        positions = new Positions(CORE, address(this), 0, 1);
        router = _deployRouter();

        PoolKey memory key = _poolKey();
        _initializeAndSeed(key);
    }

    function test_SwapExactInCoreHop() external {
        bytes memory data = _encodeOneHopRoute(address(this));

        deal(TOKEN0, address(this), SWAP_AMOUNT);
        IERC20(TOKEN0).approve(router, SWAP_AMOUNT);

        uint256 token0Before = IERC20(TOKEN0).balanceOf(address(this));
        uint256 token1Before = IERC20(TOKEN1).balanceOf(address(this));

        (bool success,) = router.call(data);
        vm.snapshotGasLastCall("yul_router", "hand_core_hop");
        assertTrue(success, "router call");

        assertEq(token0Before - IERC20(TOKEN0).balanceOf(address(this)), SWAP_AMOUNT, "token0 spent");
        assertGt(IERC20(TOKEN1).balanceOf(address(this)) - token1Before, 0, "token1 received");
    }

    function test_SwapExactInVe33Hop() external {
        PoolKey memory key = _ve33PoolKey();
        _initializeAndSeed(key);

        bytes memory data = _encodeVe33Route(address(this));

        deal(TOKEN0, address(this), SWAP_AMOUNT);
        IERC20(TOKEN0).approve(router, SWAP_AMOUNT);

        uint256 token0Before = IERC20(TOKEN0).balanceOf(address(this));
        uint256 token1Before = IERC20(TOKEN1).balanceOf(address(this));

        (bool success,) = router.call(data);
        vm.snapshotGasLastCall("yul_router", "hand_ve33_hop");
        assertTrue(success, "router call");

        assertEq(token0Before - IERC20(TOKEN0).balanceOf(address(this)), SWAP_AMOUNT, "token0 spent");
        assertGt(IERC20(TOKEN1).balanceOf(address(this)) - token1Before, 0, "token1 received");
    }

    function test_SwapExactInForwardedHop() external {
        SwapForwardee forwardee = new SwapForwardee(CORE);
        bytes memory data = _encodeSwapRoute(address(this), bytes1(uint8(1)), address(forwardee), _poolKey());

        deal(TOKEN0, address(this), SWAP_AMOUNT);
        IERC20(TOKEN0).approve(router, SWAP_AMOUNT);

        uint256 token0Before = IERC20(TOKEN0).balanceOf(address(this));
        uint256 token1Before = IERC20(TOKEN1).balanceOf(address(this));

        (bool success,) = router.call(data);
        vm.snapshotGasLastCall("yul_router", "hand_forwarded_hop");
        assertTrue(success, "router call");

        assertEq(token0Before - IERC20(TOKEN0).balanceOf(address(this)), SWAP_AMOUNT, "token0 spent");
        assertGt(IERC20(TOKEN1).balanceOf(address(this)) - token1Before, 0, "token1 received");
    }

    function test_WrapperHop() external {
        bytes memory data = bytes.concat(
            _encodeRoutePrefix(TOKEN0, WRAPPED_TOKEN0, address(this), int128(0), int128(SWAP_AMOUNT), 0),
            bytes16(SWAP_AMOUNT),
            bytes1(uint8(0)), // one hop
            bytes1(uint8(3)), // wrapper hop
            bytes1(uint8(0)) // wrap
        );

        deal(TOKEN0, address(this), SWAP_AMOUNT);
        IERC20(TOKEN0).approve(router, SWAP_AMOUNT);

        uint256 token0Before = IERC20(TOKEN0).balanceOf(address(this));
        uint256 wrappedBefore = IERC20(WRAPPED_TOKEN0).balanceOf(address(this));

        (bool success,) = router.call(data);
        vm.snapshotGasLastCall("yul_router", "hand_wrapper_hop");
        assertTrue(success, "router call");

        assertEq(token0Before - IERC20(TOKEN0).balanceOf(address(this)), SWAP_AMOUNT, "token0 spent");
        assertEq(IERC20(WRAPPED_TOKEN0).balanceOf(address(this)) - wrappedBefore, SWAP_AMOUNT, "wrapped received");
    }

    function test_SwapExactInMultiMultiHop() external {
        PoolKey memory key01 = _poolKey(TOKEN0, TOKEN1);
        PoolKey memory key12 = _poolKey(TOKEN1, TOKEN2);
        PoolKey memory key02 = _poolKey(TOKEN0, TOKEN2);
        _initializeAndSeed(key12);
        _initializeAndSeed(key02);

        bytes memory data = bytes.concat(
            _encodeRoutePrefix(TOKEN0, TOKEN2, address(this), int128(0), int128(SWAP_AMOUNT), 1),
            bytes16(SWAP_AMOUNT),
            bytes1(uint8(0)), // one hop
            _encodeSwapHop(bytes1(uint8(0)), address(0), key02),
            bytes16(SWAP_AMOUNT),
            bytes1(uint8(1)), // two hops
            _encodeSwapHop(bytes1(uint8(0)), address(0), key01),
            _encodePathToken(TOKEN1),
            _encodeSwapHop(bytes1(uint8(0)), address(0), key12)
        );

        deal(TOKEN0, address(this), SWAP_AMOUNT * 2);
        IERC20(TOKEN0).approve(router, SWAP_AMOUNT * 2);

        uint256 token0Before = IERC20(TOKEN0).balanceOf(address(this));
        uint256 token2Before = IERC20(TOKEN2).balanceOf(address(this));

        (bool success,) = router.call(data);
        vm.snapshotGasLastCall("yul_router", "hand_multi_multihop");
        assertTrue(success, "router call");

        assertEq(token0Before - IERC20(TOKEN0).balanceOf(address(this)), SWAP_AMOUNT * 2, "token0 spent");
        assertGt(IERC20(TOKEN2).balanceOf(address(this)) - token2Before, 0, "token2 received");
    }

    function test_SdkGeneratedRoutes() external {
        SdkCases memory c = _sdkCases();

        _executeSdkSwap("sdk_core_hop", c.core, TOKEN0, TOKEN1, SWAP_AMOUNT);

        PoolKey memory key = _ve33PoolKey();
        _initializeAndSeed(key);
        _executeSdkSwap("sdk_ve33_hop", c.ve33, TOKEN0, TOKEN1, SWAP_AMOUNT);

        _executeSdkSwap("sdk_wrapper_hop", c.wrapper, TOKEN0, WRAPPED_TOKEN0, SWAP_AMOUNT);

        _initializeAndSeed(_poolKey(TOKEN1, TOKEN2));
        _initializeAndSeed(_poolKey(TOKEN0, TOKEN2));
        _executeSdkSwap("sdk_multi_multihop", c.multiMultiHop, TOKEN0, TOKEN2, SWAP_AMOUNT * 2);
    }

    function testRevert_DelegateCall() external {
        DelegateCaller caller = new DelegateCaller();

        vm.expectRevert(DelegateCall.selector);
        caller.delegate(router, _encodeOneHopRoute(address(this)));
    }

    function testRevert_ForwardNotAllowed() external {
        forwardTarget = router;

        vm.expectRevert(ForwardNotAllowed.selector);
        CORE.lock();
    }

    function testRevert_NoClaimIntegrationFeesSurface() external {
        bytes memory data = abi.encodeWithSignature("claimIntegrationFees(address[])", new address[](0));

        vm.expectRevert();
        router.call(data);
    }

    function testRevert_AdversarialCalldataCannotUseFakePayer() external {
        address victim = makeAddr("victim");
        address attacker = makeAddr("attacker");
        bytes memory data =
            bytes.concat(_encodeOneHopRoute(attacker), bytes32(uint256(uint160(victim))), bytes32(uint256(0)));

        deal(TOKEN0, victim, SWAP_AMOUNT);
        vm.prank(victim);
        IERC20(TOKEN0).approve(router, SWAP_AMOUNT);

        uint256 victimBalanceBefore = IERC20(TOKEN0).balanceOf(victim);
        uint256 victimAllowanceBefore = IERC20(TOKEN0).allowance(victim, router);

        vm.prank(attacker);
        _assertRouterReverts(data, InvalidRoute.selector);

        assertEq(IERC20(TOKEN0).balanceOf(victim), victimBalanceBefore, "victim balance");
        assertEq(IERC20(TOKEN0).allowance(victim, router), victimAllowanceBefore, "victim allowance");
    }

    function testRevert_ExactInSlippageDoesNotSpendAllowance() external {
        bytes memory data = _encodeSwapRouteWithAmounts(
            address(this),
            bytes1(uint8(0)),
            address(0),
            _poolKey(),
            TOKEN0,
            TOKEN1,
            int128(POSITION_AMOUNT),
            int128(SWAP_AMOUNT)
        );

        deal(TOKEN0, address(this), SWAP_AMOUNT);
        IERC20(TOKEN0).approve(router, SWAP_AMOUNT);

        uint256 allowanceBefore = IERC20(TOKEN0).allowance(address(this), router);

        _assertRouterReverts(data, SlippageCheckFailed.selector);

        assertEq(IERC20(TOKEN0).allowance(address(this), router), allowanceBefore, "caller allowance");
    }

    function testRevert_ExactOutSlippageDoesNotSpendAllowance() external {
        bytes memory data = _encodeSwapRouteWithAmounts(
            address(this), bytes1(uint8(0)), address(0), _poolKey(), TOKEN0, TOKEN1, -int128(1), -int128(SWAP_AMOUNT)
        );

        deal(TOKEN1, address(this), POSITION_AMOUNT);
        IERC20(TOKEN1).approve(router, POSITION_AMOUNT);

        uint256 allowanceBefore = IERC20(TOKEN1).allowance(address(this), router);

        _assertRouterReverts(data, SlippageCheckFailed.selector);

        assertEq(IERC20(TOKEN1).allowance(address(this), router), allowanceBefore, "caller allowance");
    }

    function testRevert_ArbitraryForwardeeCannotLeaveThirdTokenDebt() external {
        DebtForwardee forwardee = new DebtForwardee(CORE, TOKEN2, SWAP_AMOUNT, 1);
        bytes memory data = _encodeSwapRouteWithAmounts(
            address(this),
            bytes1(uint8(1)),
            address(forwardee),
            _poolKey(),
            TOKEN0,
            TOKEN1,
            int128(0),
            int128(SWAP_AMOUNT)
        );

        deal(TOKEN0, address(this), SWAP_AMOUNT);
        deal(TOKEN2, CORE_ADDRESS, 1);
        IERC20(TOKEN0).approve(router, SWAP_AMOUNT);

        _assertRouterReverts(data, IFlashAccountant.DebtsNotZeroed.selector);
    }

    function testFuzz_ExactInCannotSpendMoreThanSpecifiedAmount(
        address recipient,
        uint128 rawAmountIn,
        uint128 rawApprovalHeadroom
    ) external {
        address payer = makeAddr("fuzz payer");
        uint128 amountIn = uint128(bound(rawAmountIn, 1, POSITION_AMOUNT / 1000));
        uint128 approvalHeadroom = uint128(bound(rawApprovalHeadroom, 0, POSITION_AMOUNT / 1000));
        uint256 allowance = uint256(amountIn) + approvalHeadroom;
        bytes memory data = _encodeSwapRouteWithAmounts(
            recipient, bytes1(uint8(0)), address(0), _poolKey(), TOKEN0, TOKEN1, int128(0), int128(amountIn)
        );

        deal(TOKEN0, payer, allowance);
        vm.prank(payer);
        IERC20(TOKEN0).approve(router, allowance);

        uint256 balanceBefore = IERC20(TOKEN0).balanceOf(payer);
        uint256 allowanceBefore = IERC20(TOKEN0).allowance(payer, router);

        vm.prank(payer);
        (bool success,) = router.call(data);

        assertTrue(success, "router call");
        assertEq(balanceBefore - IERC20(TOKEN0).balanceOf(payer), amountIn, "payer spent");
        assertEq(allowanceBefore - IERC20(TOKEN0).allowance(payer, router), amountIn, "allowance spent");
    }

    function testFuzz_RecipientApprovalIsNeverUsedAsPayer(address recipient, uint128 rawAmountIn) external {
        address payer = makeAddr("fuzz payer");
        vm.assume(recipient != payer);
        vm.assume(recipient != CORE_ADDRESS);

        uint128 amountIn = uint128(bound(rawAmountIn, 1, POSITION_AMOUNT / 1000));
        bytes memory data = _encodeSwapRouteWithAmounts(
            recipient, bytes1(uint8(0)), address(0), _poolKey(), TOKEN0, TOKEN1, int128(0), int128(amountIn)
        );

        deal(TOKEN0, payer, amountIn);
        deal(TOKEN0, recipient, amountIn * 2);

        vm.prank(payer);
        IERC20(TOKEN0).approve(router, amountIn);

        vm.prank(recipient);
        IERC20(TOKEN0).approve(router, amountIn * 2);

        uint256 recipientBalanceBefore = IERC20(TOKEN0).balanceOf(recipient);
        uint256 recipientAllowanceBefore = IERC20(TOKEN0).allowance(recipient, router);
        uint256 payerBalanceBefore = IERC20(TOKEN0).balanceOf(payer);

        vm.prank(payer);
        (bool success,) = router.call(data);

        assertTrue(success, "router call");
        assertEq(payerBalanceBefore - IERC20(TOKEN0).balanceOf(payer), amountIn, "payer spent");
        assertEq(IERC20(TOKEN0).balanceOf(recipient), recipientBalanceBefore, "recipient balance");
        assertEq(IERC20(TOKEN0).allowance(recipient, router), recipientAllowanceBefore, "recipient allowance");
    }

    function testFuzz_ExactOutCannotSpendMoreThanInputThreshold(
        address recipient,
        uint128 rawAmountOut,
        uint128 rawMaxInput
    ) external {
        address payer = makeAddr("fuzz payer");
        uint128 amountOut = uint128(bound(rawAmountOut, 1, POSITION_AMOUNT / 1000));
        uint128 maxInput = uint128(bound(rawMaxInput, 1, POSITION_AMOUNT / 1000));
        bytes memory data = _encodeSwapRouteWithAmounts(
            recipient, bytes1(uint8(0)), address(0), _poolKey(), TOKEN0, TOKEN1, -int128(maxInput), -int128(amountOut)
        );

        deal(TOKEN1, payer, maxInput);
        vm.prank(payer);
        IERC20(TOKEN1).approve(router, maxInput);

        uint256 balanceBefore = IERC20(TOKEN1).balanceOf(payer);
        uint256 allowanceBefore = IERC20(TOKEN1).allowance(payer, router);

        vm.prank(payer);
        (bool success,) = router.call(data);

        if (success) {
            uint256 spent = balanceBefore - IERC20(TOKEN1).balanceOf(payer);

            assertGt(spent, 0, "payer spent");
            assertLe(spent, maxInput, "max input");
            assertEq(allowanceBefore - IERC20(TOKEN1).allowance(payer, router), spent, "allowance spent");
        } else {
            assertEq(IERC20(TOKEN1).balanceOf(payer), balanceBefore, "payer balance");
            assertEq(IERC20(TOKEN1).allowance(payer, router), allowanceBefore, "payer allowance");
        }
    }

    function test_CodeSize() external view {
        assertTrue(router.code.length < 10_000, "code size");
    }

    function locked_6416899205(uint256) external {
        CORE.forward(forwardTarget);
    }

    function _deployRouter() private returns (address deployed) {
        bytes memory initcode = vm.parseJsonBytes(vm.readFile("out/YulRouter.yul/YulRouter.json"), ".bytecode.object");
        bytes memory code = bytes.concat(initcode, abi.encode(CORE_ADDRESS));

        assembly ("memory-safe") {
            deployed := create(0, add(code, 0x20), mload(code))
        }

        assertTrue(deployed != address(0), "router deploy");
    }

    function _sdkCases() private returns (SdkCases memory c) {
        string[] memory command = new string[](2);
        command[0] = "bun";
        command[1] = "sdk/scripts/generate-foundry-testdata.mjs";

        c = abi.decode(vm.ffi(command), (SdkCases));
    }

    function _executeSdkSwap(
        string memory gasName,
        bytes memory data,
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) private {
        deal(tokenIn, address(this), amountIn);
        IERC20(tokenIn).approve(router, amountIn);

        uint256 tokenInBefore = IERC20(tokenIn).balanceOf(address(this));
        uint256 tokenOutBefore = IERC20(tokenOut).balanceOf(address(this));

        (bool success,) = router.call(data);
        vm.snapshotGasLastCall("yul_router", gasName);
        assertTrue(success, gasName);

        assertEq(tokenInBefore - IERC20(tokenIn).balanceOf(address(this)), amountIn, "tokenIn spent");
        assertGt(IERC20(tokenOut).balanceOf(address(this)) - tokenOutBefore, 0, "tokenOut received");
    }

    function _assertRouterReverts(bytes memory data, bytes4 selector) private {
        (bool success, bytes memory returndata) = router.call(data);

        assertFalse(success, "router call");
        assertGe(returndata.length, 4, "revert data length");
        assertEq(_selector(returndata), selector, "revert selector");
    }

    function _selector(bytes memory returndata) private pure returns (bytes4 selector) {
        assembly ("memory-safe") {
            selector := mload(add(returndata, 0x20))
        }
    }

    function _poolKey() private pure returns (PoolKey memory) {
        return _poolKey(TOKEN0, TOKEN1);
    }

    function _poolKey(address token0, address token1) private pure returns (PoolKey memory) {
        return PoolKey({token0: token0, token1: token1, config: PoolConfig.wrap(bytes32(uint256(FEE) << 32))});
    }

    function _ve33PoolKey() private pure returns (PoolKey memory) {
        return PoolKey({
            token0: TOKEN0,
            token1: TOKEN1,
            config: PoolConfig.wrap(bytes32((uint256(uint160(VE33)) << 96) | uint256(0x80000000 | VE33_TICK_SPACING)))
        });
    }

    function _initializeAndSeed(PoolKey memory key) private {
        positions.maybeInitializePool(key, 0);

        deal(key.token0, address(this), POSITION_AMOUNT);
        deal(key.token1, address(this), POSITION_AMOUNT);
        IERC20(key.token0).approve(address(positions), POSITION_AMOUNT);
        IERC20(key.token1).approve(address(positions), POSITION_AMOUNT);

        int32 tickLower;
        int32 tickUpper;
        if (key.config.isConcentrated()) {
            int32 spacing = int32(key.config.concentratedTickSpacing());
            tickLower = -spacing;
            tickUpper = spacing;
        } else {
            (tickLower, tickUpper) = key.config.stableswapActiveLiquidityTickRange();
        }

        positions.mintAndDeposit(key, tickLower, tickUpper, POSITION_AMOUNT, POSITION_AMOUNT, 0);
    }

    function _encodeOneHopRoute(address recipient) private pure returns (bytes memory) {
        PoolKey memory key = _poolKey();

        return _encodeSwapRoute(recipient, bytes1(uint8(0)), address(0), key);
    }

    function _encodeVe33Route(address recipient) private pure returns (bytes memory) {
        PoolKey memory key = _ve33PoolKey();

        return _encodeSwapRoute(recipient, bytes1(uint8(3)), VE33, key);
    }

    function _encodeSwapRoute(address recipient, bytes1 hopType, address forwardee, PoolKey memory key)
        private
        pure
        returns (bytes memory)
    {
        return _encodeSwapRouteWithAmounts(
            recipient, hopType, forwardee, key, TOKEN0, TOKEN1, int128(0), int128(SWAP_AMOUNT)
        );
    }

    function _encodeSwapRouteWithAmounts(
        address recipient,
        bytes1 hopType,
        address forwardee,
        PoolKey memory key,
        address specifiedToken,
        address calculatedToken,
        int128 threshold,
        int128 specifiedAmount
    ) private pure returns (bytes memory) {
        return bytes.concat(
            _encodeRoutePrefix(specifiedToken, calculatedToken, recipient, threshold, specifiedAmount, 0),
            bytes16(_absInt128(specifiedAmount)),
            bytes1(uint8(0)), // one hop
            _encodeSwapHop(hopType, forwardee, key)
        );
    }

    function _encodeSwapHop(bytes1 hopType, address forwardee, PoolKey memory key) private pure returns (bytes memory) {
        uint256 config = uint256(PoolConfig.unwrap(key.config));

        if (hopType == bytes1(uint8(1))) {
            return bytes.concat(bytes1(uint8(2)), bytes1(0), bytes20(forwardee), bytes32(PoolConfig.unwrap(key.config)));
        }

        if (hopType == bytes1(uint8(3))) {
            return bytes.concat(bytes1(uint8(4)), bytes1(0), bytes20(forwardee), bytes4(uint32(config)));
        }

        address extension = address(uint160(config >> 96));
        if (extension == address(0)) {
            return bytes.concat(bytes1(uint8(0)), bytes1(0), bytes8(uint64(config >> 32)), bytes4(uint32(config)));
        }

        return bytes.concat(bytes1(uint8(1)), bytes1(0), bytes32(PoolConfig.unwrap(key.config)));
    }

    function _encodeRoutePrefix(
        address specifiedToken,
        address calculatedToken,
        address recipient,
        int128 threshold,
        int128 specifiedAmount,
        uint8 additionalMultiHops
    ) private pure returns (bytes memory) {
        uint8 flags = 1; // has recipient
        if (specifiedAmount < 0) flags |= 2;
        if (specifiedToken == address(0)) flags |= 8;
        if (calculatedToken == address(0)) flags |= 16;

        bytes memory thresholdPart = threshold == 0 ? bytes("") : abi.encodePacked(bytes16(_absInt128(threshold)));

        return bytes.concat(
            bytes1(flags),
            bytes1(additionalMultiHops),
            bytes1(uint8(16)), // hand-written tests use a fixed amount width
            bytes1(uint8(thresholdPart.length)),
            thresholdPart,
            specifiedToken == address(0) ? bytes("") : abi.encodePacked(bytes20(specifiedToken)),
            calculatedToken == address(0) ? bytes("") : abi.encodePacked(bytes20(calculatedToken)),
            bytes20(recipient)
        );
    }

    function _encodePathToken(address token) private pure returns (bytes memory) {
        if (token == address(0)) return abi.encodePacked(bytes1(uint8(0)));
        return abi.encodePacked(bytes1(uint8(1)), bytes20(token));
    }

    function _encodeInt128(int128 value) private pure returns (uint128 encoded) {
        assembly ("memory-safe") {
            encoded := value
        }
    }

    function _absInt128(int128 value) private pure returns (uint128) {
        return uint128(value < 0 ? -value : value);
    }
}
