// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {Core} from "ekubo/Core.sol";
import {Positions} from "ekubo/Positions.sol";
import {TokenWrapper} from "ekubo/TokenWrapper.sol";
import {Ve33} from "ekubo/extensions/Ve33.sol";
import {ICore} from "ekubo/interfaces/ICore.sol";
import {IFlashAccountant} from "ekubo/interfaces/IFlashAccountant.sol";
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

contract YulRouterTest is Test {
    error DelegateCall();
    error ForwardNotAllowed();
    error InvalidCaller();

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

        (bool success, bytes memory returndata) = router.call(data);
        vm.snapshotGasLastCall("yul_router", "hand_core_hop");
        assertTrue(success, "router call");

        int256 calculatedAmount = abi.decode(returndata, (int256));
        assertGt(calculatedAmount, int256(0), "calculated amount");
        assertEq(token0Before - IERC20(TOKEN0).balanceOf(address(this)), SWAP_AMOUNT, "token0 spent");
        assertEq(IERC20(TOKEN1).balanceOf(address(this)) - token1Before, uint256(calculatedAmount), "token1 received");
    }

    function test_SwapExactInVe33Hop() external {
        PoolKey memory key = _ve33PoolKey();
        _initializeAndSeed(key);

        bytes memory data = _encodeVe33Route(address(this));

        deal(TOKEN0, address(this), SWAP_AMOUNT);
        IERC20(TOKEN0).approve(router, SWAP_AMOUNT);

        uint256 token0Before = IERC20(TOKEN0).balanceOf(address(this));
        uint256 token1Before = IERC20(TOKEN1).balanceOf(address(this));

        (bool success, bytes memory returndata) = router.call(data);
        vm.snapshotGasLastCall("yul_router", "hand_ve33_hop");
        assertTrue(success, "router call");

        int256 calculatedAmount = abi.decode(returndata, (int256));
        assertGt(calculatedAmount, int256(0), "calculated amount");
        assertEq(token0Before - IERC20(TOKEN0).balanceOf(address(this)), SWAP_AMOUNT, "token0 spent");
        assertEq(IERC20(TOKEN1).balanceOf(address(this)) - token1Before, uint256(calculatedAmount), "token1 received");
    }

    function test_WrapperHop() external {
        bytes memory data = bytes.concat(
            bytes1(uint8(1)), // has recipient
            bytes1(uint8(0)), // one multi-hop
            bytes20(TOKEN0),
            bytes20(WRAPPED_TOKEN0),
            bytes16(uint128(0)),
            bytes20(address(this)),
            bytes16(SWAP_AMOUNT),
            bytes1(uint8(0)), // one hop
            bytes1(uint8(2)), // wrapper hop
            bytes20(TOKEN0),
            bytes20(WRAPPED_TOKEN0)
        );

        deal(TOKEN0, address(this), SWAP_AMOUNT);
        IERC20(TOKEN0).approve(router, SWAP_AMOUNT);

        uint256 token0Before = IERC20(TOKEN0).balanceOf(address(this));
        uint256 wrappedBefore = IERC20(WRAPPED_TOKEN0).balanceOf(address(this));

        (bool success, bytes memory returndata) = router.call(data);
        vm.snapshotGasLastCall("yul_router", "hand_wrapper_hop");
        assertTrue(success, "router call");

        int256 calculatedAmount = abi.decode(returndata, (int256));
        assertEq(calculatedAmount, int256(uint256(SWAP_AMOUNT)), "calculated amount");
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
            bytes1(uint8(1)), // has recipient
            bytes1(uint8(1)), // two multi-hops
            bytes20(TOKEN0),
            bytes20(TOKEN2),
            bytes16(uint128(0)),
            bytes20(address(this)),
            bytes16(SWAP_AMOUNT),
            bytes1(uint8(0)), // one hop
            _encodeSwapHop(bytes1(uint8(0)), address(0), key02),
            bytes16(SWAP_AMOUNT),
            bytes1(uint8(1)), // two hops
            _encodeSwapHop(bytes1(uint8(0)), address(0), key01),
            _encodeSwapHop(bytes1(uint8(0)), address(0), key12)
        );

        deal(TOKEN0, address(this), SWAP_AMOUNT * 2);
        IERC20(TOKEN0).approve(router, SWAP_AMOUNT * 2);

        uint256 token0Before = IERC20(TOKEN0).balanceOf(address(this));
        uint256 token2Before = IERC20(TOKEN2).balanceOf(address(this));

        (bool success, bytes memory returndata) = router.call(data);
        vm.snapshotGasLastCall("yul_router", "hand_multi_multihop");
        assertTrue(success, "router call");

        int256 calculatedAmount = abi.decode(returndata, (int256));
        assertGt(calculatedAmount, int256(0), "calculated amount");
        assertEq(token0Before - IERC20(TOKEN0).balanceOf(address(this)), SWAP_AMOUNT * 2, "token0 spent");
        assertEq(IERC20(TOKEN2).balanceOf(address(this)) - token2Before, uint256(calculatedAmount), "token2 received");
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

        (bool success, bytes memory returndata) = router.call(data);
        vm.snapshotGasLastCall("yul_router", gasName);
        assertTrue(success, gasName);

        int256 calculatedAmount = abi.decode(returndata, (int256));
        assertGt(calculatedAmount, int256(0), "calculated amount");
        assertEq(tokenInBefore - IERC20(tokenIn).balanceOf(address(this)), amountIn, "tokenIn spent");
        assertEq(
            IERC20(tokenOut).balanceOf(address(this)) - tokenOutBefore, uint256(calculatedAmount), "tokenOut received"
        );
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
        return bytes.concat(
            bytes1(uint8(1)), // has recipient
            bytes1(uint8(0)), // one multi-hop
            bytes20(TOKEN0),
            bytes20(TOKEN1),
            bytes16(uint128(0)),
            bytes20(recipient),
            bytes16(SWAP_AMOUNT),
            bytes1(uint8(0)), // one hop
            _encodeSwapHop(hopType, forwardee, key)
        );
    }

    function _encodeSwapHop(bytes1 hopType, address forwardee, PoolKey memory key) private pure returns (bytes memory) {
        bytes memory forwardeePart = hopType == bytes1(uint8(1)) || hopType == bytes1(uint8(3))
            ? abi.encodePacked(bytes20(forwardee))
            : bytes("");

        return bytes.concat(
            hopType,
            forwardeePart,
            bytes20(key.token0),
            bytes20(key.token1),
            bytes32(PoolConfig.unwrap(key.config)),
            bytes12(uint96(0)), // default sqrt ratio limit
            bytes4(uint32(0))
        );
    }
}
