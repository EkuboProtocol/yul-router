// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {Positions} from "ekubo/Positions.sol";
import {ContinuousAuction, continuousAuctionCallPoints} from "ekubo/extensions/ContinuousAuction.sol";
import {ICore} from "ekubo/interfaces/ICore.sol";
import {ContinuousAuctionLib} from "ekubo/libraries/ContinuousAuctionLib.sol";
import {CoreLib} from "ekubo/libraries/CoreLib.sol";
import {FlashAccountantLib} from "ekubo/libraries/FlashAccountantLib.sol";
import {amountBeforeFee, computeFee} from "ekubo/math/fee.sol";
import {PoolConfig, createConcentratedPoolConfig} from "ekubo/types/poolConfig.sol";
import {PoolKey} from "ekubo/types/poolKey.sol";
import {Test} from "forge-std/Test.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

/// @notice Routes through the real ContinuousAuction extension with the router's `forwarded` hop, which is how an
/// ordinary trader reaches an auction pool. The router is never the holder's executor, so every routed swap pays
/// the holder's fee, and the route's threshold is checked against the fee-inclusive amounts the extension returns.
contract ContinuousAuctionRouterTest is Test {
    using CoreLib for ICore;
    using FlashAccountantLib for ICore;

    error DeadlineExpired();
    error SlippageCheckFailed(int256);
    error PoolClosed();

    bytes4 private constant QUOTE_SELECTOR = bytes4(keccak256("quote(bytes)"));
    ICore private constant CORE = ICore(payable(0x00000000000014aA86C5d3c41765bb24e11bd701));
    address private constant TOKEN0 = 0x1111111111111111111111111111111111111111;
    address private constant TOKEN1 = 0x2222222222222222222222222222222222222222;
    address private constant BID_TOKEN = 0x4444444444444444444444444444444444444444;

    uint128 private constant POSITION_AMOUNT = 100_000 ether;
    uint128 private constant SWAP_AMOUNT = 1 ether;
    uint32 private constant TICK_SPACING = 16;
    uint32 private constant FEE = 42_949_672; // 1% as a 0.32 fraction
    uint96 private constant RATE = 1e12;
    uint64 private constant TENURE = 1 days;
    bytes32 private constant SALT = bytes32(0);

    enum Action {
        Bid,
        Forward
    }

    ContinuousAuction private auction;
    Positions private positions;
    address private router;
    address private executor;
    PoolKey private key;

    Action private action;
    uint64 private bidEnd;
    uint32 private bidFee;
    bytes private forwardData;
    bytes private forwardResult;

    function setUp() public {
        vm.warp(1_000_000);
        deployCodeTo("Core.sol:Core", address(CORE));
        deployCodeTo("YulRouter.t.sol:TestToken", TOKEN0);
        deployCodeTo("YulRouter.t.sol:TestToken", TOKEN1);
        deployCodeTo("YulRouter.t.sol:TestToken", BID_TOKEN);
        address auctionAddress = address((uint160(continuousAuctionCallPoints().toUint8()) << 152) | 1);
        deployCodeTo("ContinuousAuction.sol:ContinuousAuction", abi.encode(CORE, BID_TOKEN), auctionAddress);
        auction = ContinuousAuction(auctionAddress);
        positions = new Positions(CORE, address(this), 0, 1);
        router = _deployRouter();
        executor = makeAddr("holder executor");

        key = PoolKey({
            token0: TOKEN0, token1: TOKEN1, config: createConcentratedPoolConfig(0, TICK_SPACING, auctionAddress)
        });
        positions.maybeInitializePool(key, 0);
        deal(TOKEN0, address(this), POSITION_AMOUNT);
        deal(TOKEN1, address(this), POSITION_AMOUNT);
        IERC20(TOKEN0).approve(address(positions), POSITION_AMOUNT);
        IERC20(TOKEN1).approve(address(positions), POSITION_AMOUNT);
        int32 range = int32(TICK_SPACING) * 1000;
        positions.mintAndDeposit(key, -range, range, POSITION_AMOUNT, POSITION_AMOUNT, 0);

        deal(BID_TOKEN, address(this), type(uint128).max);
    }

    function test_ForwardedAuctionHopPaysHolderFeeExactIn() external {
        _rent(FEE);
        bytes memory data = _route(TOKEN0, TOKEN1, int128(SWAP_AMOUNT), 1, false, 0);
        (, uint128 fee1Before) = _feesOwed();

        deal(TOKEN0, address(this), SWAP_AMOUNT);
        IERC20(TOKEN0).approve(router, SWAP_AMOUNT);
        (bool success, bytes memory result) = router.call(data);
        vm.snapshotGasLastCall("yul_router_auction", "exact_in");
        assertTrue(success, "router call");

        (,, int256 specified, int256 calculated) = abi.decode(result, (address, address, int256, int256));
        (uint128 fee0, uint128 fee1) = _feesOwed();
        fee1 -= fee1Before;
        assertEq(specified, int256(uint256(SWAP_AMOUNT)), "specified amount");
        assertEq(fee0, 0, "no input fee on exact input");
        assertGt(fee1, 0, "holder fee");
        // The holder's fee comes out of the pool's output, so the trader's amount is net of it.
        assertEq(fee1, computeFee(uint128(uint256(calculated)) + fee1, uint64(FEE) << 32), "fee on gross output");
        assertEq(IERC20(TOKEN0).balanceOf(address(this)), 0, "input spent");
        assertEq(IERC20(TOKEN1).balanceOf(address(this)), uint256(calculated), "net output received");
    }

    function test_ForwardedAuctionHopPaysHolderFeeExactOut() external {
        _rent(FEE);
        bytes memory data = _route(TOKEN1, TOKEN0, -int128(SWAP_AMOUNT), type(int128).min, false, 0);

        deal(TOKEN0, address(this), 2 * SWAP_AMOUNT);
        IERC20(TOKEN0).approve(router, 2 * SWAP_AMOUNT);
        (bool success, bytes memory result) = router.call(data);
        vm.snapshotGasLastCall("yul_router_auction", "exact_out");
        assertTrue(success, "router call");

        (,, int256 specified, int256 calculated) = abi.decode(result, (address, address, int256, int256));
        (uint128 fee0, uint128 fee1) = _feesOwed();
        uint128 paid = uint128(uint256(-calculated));
        assertEq(specified, -int256(uint256(SWAP_AMOUNT)), "specified amount");
        assertEq(fee1, 0, "no output fee on exact output");
        assertGt(fee0, 0, "holder fee");
        // The holder's fee is added to the pool's input, so the trader's amount includes it.
        assertEq(amountBeforeFee(paid - fee0, uint64(FEE) << 32), paid, "fee on gross input");
        assertEq(2 * SWAP_AMOUNT - IERC20(TOKEN0).balanceOf(address(this)), paid, "fee-inclusive input spent");
        assertEq(IERC20(TOKEN1).balanceOf(address(this)), SWAP_AMOUNT, "exact output received");
    }

    /// @dev A trader quotes, applies a slippage tolerance, and submits without a deadline. The holder then raises
    /// its fee to the maximum, effective from the next second. The route still fills in the quoting second, and
    /// reverts afterward because its threshold binds the fee-inclusive amount.
    function testFuzz_QuoteDerivedThresholdRevertsAfterMaxFee(bool exactOut, bool reverse) external {
        _rent(FEE);
        (address specifiedToken, address calculatedToken) = reverse ? (TOKEN1, TOKEN0) : (TOKEN0, TOKEN1);
        int128 amount = exactOut ? -int128(SWAP_AMOUNT) : int128(SWAP_AMOUNT);
        int256 quoted =
            _quote(_route(specifiedToken, calculatedToken, amount, exactOut ? type(int128).min : int128(1), false, 0));
        // 1% tolerance: at least 99% of the quoted output, or at most 101% of the quoted input.
        int128 threshold = int128(quoted * (exactOut ? int256(101) : int256(99)) / 100);
        bytes memory data = _route(specifiedToken, calculatedToken, amount, threshold, false, 0);
        deal(specifiedToken, address(this), 2 * SWAP_AMOUNT);
        deal(calculatedToken, address(this), 2 * SWAP_AMOUNT);
        IERC20(specifiedToken).approve(router, 2 * SWAP_AMOUNT);
        IERC20(calculatedToken).approve(router, 2 * SWAP_AMOUNT);

        _placeBid(type(uint32).max);

        uint256 state = vm.snapshotState();
        (bool success, bytes memory result) = router.call(data);
        assertTrue(success, "the fee change is not live in the second it is placed");
        (,,, int256 calculated) = abi.decode(result, (address, address, int256, int256));
        assertEq(calculated, quoted, "same-second execution matches the quote");
        assertTrue(vm.revertToState(state), "restore state");

        vm.warp(block.timestamp + 1);
        int256 requoted =
            _quote(_route(specifiedToken, calculatedToken, amount, exactOut ? type(int128).min : int128(0), false, 0));
        (success, result) = router.call(data);
        assertFalse(success, "bounded swap on a max-fee pool");
        assertEq(result, abi.encodeWithSelector(SlippageCheckFailed.selector, requoted), "fee-inclusive threshold");
    }

    function testFuzz_ExpiredDeadlineReverts(uint8 mode) external {
        _rent(FEE);
        uint32 deadline = uint32(block.timestamp);
        bytes memory data = _route(TOKEN0, TOKEN1, int128(SWAP_AMOUNT), 1, true, deadline);
        deal(TOKEN0, address(this), SWAP_AMOUNT);
        IERC20(TOKEN0).approve(router, SWAP_AMOUNT);

        _placeBid(type(uint32).max);

        uint256 state = vm.snapshotState();
        (bool success,) = _callInMode(data, mode);
        assertTrue(success, "route fills through its deadline second");
        assertTrue(vm.revertToState(state), "restore state");

        vm.warp(uint256(deadline) + 1);
        bytes memory result;
        (success, result) = _callInMode(data, mode);
        assertFalse(success, "expired route");
        assertEq(result, abi.encodeWithSelector(DeadlineExpired.selector), "expiry error");
    }

    function testFuzz_ClosedPoolReverts(uint8 mode, bool everRented) external {
        if (everRented) {
            _rent(FEE);
            vm.warp(bidEnd);
        }
        bytes memory data = _route(TOKEN0, TOKEN1, int128(SWAP_AMOUNT), 1, false, 0);
        deal(TOKEN0, address(this), SWAP_AMOUNT);
        IERC20(TOKEN0).approve(router, SWAP_AMOUNT);

        (bool success, bytes memory result) = _callInMode(data, mode);

        assertFalse(success, "closed pool");
        assertEq(result, abi.encodeWithSelector(PoolClosed.selector), "extension error bubbles");
    }

    /// @dev quote(bytes), direct execution and Core.forward return identical fee-inclusive amounts, and the settled
    /// balances and the holder's fee match them.
    function testFuzz_QuoteEqualsExecution(uint128 rawAmount, uint32 fee, bool exactOut, bool reverse) external {
        fee = uint32(bound(fee, 0, type(uint32).max / 2));
        _rent(fee);
        uint128 magnitude = uint128(bound(rawAmount, 1, POSITION_AMOUNT / 100));
        (address specifiedToken, address calculatedToken) = reverse ? (TOKEN1, TOKEN0) : (TOKEN0, TOKEN1);
        int128 amount = exactOut ? -int128(magnitude) : int128(magnitude);
        bytes memory data = _route(
            specifiedToken,
            calculatedToken,
            amount,
            exactOut ? type(int128).min : int128(0),
            true,
            uint32(block.timestamp)
        );
        deal(TOKEN0, address(this), POSITION_AMOUNT);
        deal(TOKEN1, address(this), POSITION_AMOUNT);
        IERC20(TOKEN0).approve(router, POSITION_AMOUNT);
        IERC20(TOKEN1).approve(router, POSITION_AMOUNT);

        (bool success, bytes memory quoteResult) = router.call(abi.encodeWithSelector(QUOTE_SELECTOR, data));
        assertTrue(success, "quote");
        uint256 state = vm.snapshotState();

        (success, forwardResult) = router.call(data);
        assertTrue(success, "direct");
        assertEq(forwardResult, quoteResult, "direct equals quote");
        (,, int256 specified, int256 calculated) = abi.decode(quoteResult, (address, address, int256, int256));
        _assertSettledAndCharged(specifiedToken, calculatedToken, specified, calculated, fee, exactOut);

        assertTrue(vm.revertToState(state), "restore state");
        action = Action.Forward;
        forwardData = data;
        CORE.lock();
        assertEq(forwardResult, quoteResult, "forwarded equals quote");
        _assertSettledAndCharged(specifiedToken, calculatedToken, specified, calculated, fee, exactOut);
    }

    function test_QuoteGas() external {
        _rent(FEE);
        (bool success,) = router.call(
            abi.encodeWithSelector(QUOTE_SELECTOR, _route(TOKEN0, TOKEN1, int128(SWAP_AMOUNT), 1, false, 0))
        );
        vm.snapshotGasLastCall("yul_router_auction", "quote");
        assertTrue(success, "quote");
    }

    function _assertSettledAndCharged(
        address specifiedToken,
        address calculatedToken,
        int256 specified,
        int256 calculated,
        uint32 fee,
        bool exactOut
    ) private view {
        uint256 specifiedBalance = IERC20(specifiedToken).balanceOf(address(this));
        uint256 calculatedBalance = IERC20(calculatedToken).balanceOf(address(this));
        assertEq(int256(uint256(POSITION_AMOUNT)) - int256(specifiedBalance), specified, "specified settled");
        assertEq(int256(calculatedBalance) - int256(uint256(POSITION_AMOUNT)), calculated, "calculated settled");

        (uint128 fee0, uint128 fee1) = _feesOwed();
        // Exact input pays on the output (calculated) token; exact output pays on the input (calculated) token.
        uint128 charged = calculatedToken == TOKEN0 ? fee0 : fee1;
        assertEq(calculatedToken == TOKEN0 ? fee1 : fee0, 0, "no fee in the specified token");
        uint64 fee64 = uint64(fee) << 32;
        if (exactOut) {
            uint128 paid = uint128(uint256(-calculated));
            assertEq(paid == 0 ? 0 : amountBeforeFee(paid - charged, fee64), paid, "exact-output fee");
        } else {
            assertEq(charged, computeFee(uint128(uint256(calculated)) + charged, fee64), "exact-input fee");
        }
    }

    /// @dev Places this contract's bid with a live tenure from the next second, and moves to that second.
    function _rent(uint32 fee) private {
        _placeBid(fee);
        vm.warp(block.timestamp + 1);
    }

    /// @dev Places or replaces this contract's bid from the next second on, keeping the tenure end.
    function _placeBid(uint32 fee) private {
        if (bidEnd == 0) bidEnd = uint64(block.timestamp + 1 + TENURE);
        bidFee = fee;
        action = Action.Bid;
        CORE.lock();
    }

    function locked_6416899205(uint256) external {
        require(msg.sender == address(CORE));
        if (action == Action.Bid) {
            int256 delta =
                ContinuousAuctionLib.updateBid(CORE, address(auction), key, SALT, RATE, bidEnd, executor, bidFee);
            if (delta > 0) CORE.pay(BID_TOKEN, uint256(delta));
            else if (delta < 0) CORE.withdraw(BID_TOKEN, address(this), uint128(uint256(-delta)));
        } else {
            forwardResult = CORE.forward(router, forwardData);
            (address specifiedToken, address calculatedToken, int256 specified, int256 calculated) =
                abi.decode(forwardResult, (address, address, int256, int256));
            _settle(specifiedToken, specified);
            _settle(calculatedToken, -calculated);
        }
    }

    function _settle(address token, int256 delta) private {
        if (delta > 0) CORE.pay(token, uint256(delta));
        else if (delta < 0) CORE.withdraw(token, address(this), uint128(uint256(-delta)));
    }

    /// @dev Executes directly (mode 0), through quote(bytes) (mode 1), or forwarded under this contract's lock.
    function _callInMode(bytes memory data, uint8 mode) private returns (bool success, bytes memory result) {
        mode %= 3;
        if (mode == 0) return router.call(data);
        if (mode == 1) return router.call(abi.encodeWithSelector(QUOTE_SELECTOR, data));
        action = Action.Forward;
        forwardData = data;
        return address(CORE).call(abi.encodeWithSignature("lock()"));
    }

    function _quote(bytes memory data) private returns (int256 calculated) {
        (bool success, bytes memory result) = router.call(abi.encodeWithSelector(QUOTE_SELECTOR, data));
        assertTrue(success, "quote");
        (,,, calculated) = abi.decode(result, (address, address, int256, int256));
    }

    function _feesOwed() private view returns (uint128 fee0, uint128 fee1) {
        (fee0, fee1) = auction.swapFeesOwed(key, address(this), SALT);
    }

    /// @dev One single-hop multi-hop through the auction's forwarded swap, with an optional deadline.
    function _route(
        address specifiedToken,
        address calculatedToken,
        int128 amount,
        int128 threshold,
        bool withDeadline,
        uint32 deadline
    ) private view returns (bytes memory) {
        return bytes.concat(
            bytes1(withDeadline ? uint8(2) : uint8(0)), // flags: deadline, no recipient
            bytes1(uint8(0)), // one multi-hop
            bytes20(specifiedToken),
            bytes20(calculatedToken),
            bytes16(uint128(threshold)),
            withDeadline ? abi.encodePacked(deadline) : bytes(""),
            bytes16(uint128(amount)),
            bytes1(uint8(0)), // one hop
            bytes1(uint8(1)), // forwarded
            bytes20(address(auction)),
            bytes20(key.token0),
            bytes20(key.token1),
            PoolConfig.unwrap(key.config),
            bytes12(0), // default sqrt ratio limit
            bytes4(0) // skip ahead, no partial fill
        );
    }

    function _deployRouter() private returns (address deployed) {
        bytes memory initcode = vm.parseJsonBytes(vm.readFile("out/YulRouter.yul/YulRouter.json"), ".bytecode.object");
        bytes memory code = bytes.concat(initcode, abi.encode(address(CORE)));
        assembly ("memory-safe") {
            deployed := create(0, add(code, 0x20), mload(code))
        }
        assertTrue(deployed != address(0), "router deploy");
    }
}
