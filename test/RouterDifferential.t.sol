// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.30;

import {IFlashAccountant} from "ekubo/interfaces/IFlashAccountant.sol";
import {Locker} from "ekubo/types/locker.sol";
import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

/// @dev Fills every forwarded swap exactly at a 1:1 price without touching Core debt, so arbitrary
/// multi-hop routes complete in quote and forwarded mode. Short payloads are wrapper forwards.
contract MirrorForwardee {
    /// @notice Running hash of every payload received, so a test can compare what two routers sent.
    bytes32 public digest;

    event Payload(bytes data);

    function forwarded_2374103877(Locker) external returns (bytes32 update) {
        digest = keccak256(abi.encode(digest, keccak256(msg.data)));
        emit Payload(msg.data);
        assembly ("memory-safe") {
            if gt(calldatasize(), 163) {
                let params := calldataload(132)
                let amount := signextend(15, shr(32, params))
                let mask := 0xffffffffffffffffffffffffffffffff
                switch and(shr(31, params), 1)
                case 0 { update := or(shl(128, amount), and(sub(0, amount), mask)) }
                default { update := or(shl(128, sub(0, amount)), and(amount, mask)) }
            }
        }
    }
}

/// @notice Runs identical calldata against the solc-compiled Yul object and a candidate artifact at the
/// same address and requires identical success flags, return data and forwarded payloads.
contract RouterDifferentialTest is Test {
    address private constant CORE_ADDRESS = 0x00000000000014aA86C5d3c41765bb24e11bd701;
    bytes4 private constant QUOTE_SELECTOR = 0xedfa3568;
    address private constant SPECIFIED = address(0x5bEC);
    address private constant CALCULATED = address(0xCA1C);
    string private constant BASELINE = "out/YulRouter.yul/YulRouter.json";

    address private mirror;

    function setUp() public {
        deployCodeTo("Core.sol:Core", CORE_ADDRESS);
        mirror = address(new MirrorForwardee());
    }

    /// @dev The lock passes its trailing calldata through: the router address, then the route.
    function locked_6416899205(uint256) external {
        (bool success, bytes memory result) =
            CORE_ADDRESS.call(bytes.concat(IFlashAccountant.forward.selector, msg.data[36:]));
        assembly ("memory-safe") {
            if iszero(success) { revert(add(result, 0x20), mload(result)) }
            return(add(result, 0x20), mload(result))
        }
    }

    function _deploy(string memory artifact) private returns (address deployed) {
        bytes memory initcode = vm.parseJsonBytes(vm.readFile(artifact), ".bytecode.object");
        bytes memory code = bytes.concat(initcode, abi.encode(CORE_ADDRESS));
        assembly ("memory-safe") {
            deployed := create(0, add(code, 0x20), mload(code))
        }
        assertTrue(deployed != address(0), "router deploy");
    }

    function _run(string memory artifact, bytes memory data, uint8 mode)
        private
        returns (bool success, bytes memory result, bytes32 digest)
    {
        uint256 state = vm.snapshotState();
        address router = _deploy(artifact);
        if (mode == 0) {
            bytes memory input = abi.encodeWithSelector(QUOTE_SELECTOR, data);
            (success, result) = router.call(input);
        } else {
            bytes memory input = bytes.concat(IFlashAccountant.lock.selector, abi.encode(router), data);
            (success, result) = CORE_ADDRESS.call(input);
            // Quotes roll the forwardee's storage back, so only this mode can compare payloads.
            digest = MirrorForwardee(mirror).digest();
        }
        assertTrue(vm.revertToState(state), "restore state");
    }

    function _next(uint256 seed) private pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed)));
    }

    function _signatureLength(uint256 seed) private pure returns (uint256) {
        uint256 kind = seed % 6;
        seed >>= 8;
        if (kind == 0) return 0;
        if (kind == 1) return 65;
        if (kind == 2) return seed % 300;
        // Buffers that end around 0x2080..0x2200, where Solar places spill slots.
        if (kind == 3) return 7800 + seed % 800;
        if (kind == 4) return 8100 + seed % 96;
        return seed % 20000;
    }

    function _swapHop(uint256 seed, address current, address next, int128 amount, bool single)
        private
        view
        returns (bytes memory hop)
    {
        bool signed = seed & 1 == 1;
        bool reverse = seed & 2 == 2;
        (address token0, address token1) = reverse ? (next, current) : (current, next);
        bytes12 limit = seed & 4 == 4 ? bytes12(uint96(seed >> 16)) : bytes12(0);
        uint32 skipAhead = uint32(seed >> 120) & 0x7fffffff;
        // Partial fills are only valid on single-hop paths with a nonzero amount.
        if (!signed && single && amount != 0 && seed & 8 == 8) skipAhead |= 0x80000000;
        bytes memory head = bytes.concat(
            bytes1(uint8(signed ? 4 : 1)),
            bytes20(mirror),
            bytes20(token0),
            bytes20(token1),
            bytes32(_next(seed ^ 0x636f6e666967)),
            limit,
            bytes4(skipAhead)
        );
        if (!signed) return head;
        bytes memory signature = new bytes(_signatureLength(seed >> 32));
        // Every byte is nonzero and position dependent, so any overwritten byte changes the payload.
        for (uint256 i; i < signature.length; ++i) {
            signature[i] = bytes1(uint8(1 + (i * 7 + (seed >> 40)) % 255));
        }
        return bytes.concat(
            head,
            bytes32(_next(seed ^ 0x6d657461)),
            bytes32(_next(seed ^ 0x6d696e)),
            bytes4(uint32(signature.length)),
            signature
        );
    }

    function _path(uint256 seed, int128 amount) private view returns (bytes memory path) {
        uint256 hops = 1 + seed % 4;
        address current = SPECIFIED;
        bytes memory body;
        for (uint256 i; i < hops; ++i) {
            seed = _next(seed);
            bool last = i + 1 == hops;
            address next = last ? CALCULATED : address(uint160(0x100000 + (seed >> 200)));
            if (seed % 5 == 0 && (current == mirror || !last)) {
                // Wrapper hop: the forwardee is the wrapped token itself.
                if (current == mirror) {
                    body = bytes.concat(body, bytes1(uint8(2)), bytes20(next), bytes20(mirror));
                    current = next;
                } else {
                    body = bytes.concat(body, bytes1(uint8(2)), bytes20(current), bytes20(mirror));
                    current = mirror;
                }
                continue;
            }
            body = bytes.concat(body, _swapHop(seed >> 8, current, next, amount, hops == 1));
            current = next;
        }
        return bytes.concat(bytes16(uint128(amount)), bytes1(uint8(hops - 1)), body);
    }

    function _route(uint256 seed) private view returns (bytes memory data) {
        uint256 paths = 1 + seed % 3;
        bool exactOutput = seed & 4 == 4;
        uint8 flags = uint8(seed >> 8) & 3;
        bytes memory tail;
        if (flags & 1 == 1) tail = bytes.concat(tail, bytes20(address(0xBEEF)));
        if (flags & 2 == 2) tail = bytes.concat(tail, bytes4(uint32(block.timestamp + (seed >> 16) % 3)));
        int128 threshold = exactOutput ? type(int128).min : int128(0);
        if (seed & 0x10000000 != 0) threshold = int128(int256(seed >> 100));
        data = bytes.concat(
            bytes1(flags),
            bytes1(uint8(paths - 1)),
            bytes20(SPECIFIED),
            bytes20(CALCULATED),
            bytes16(uint128(threshold)),
            tail
        );
        for (uint256 i; i < paths; ++i) {
            seed = _next(seed);
            int128 amount = int128(uint128(bound(seed >> 128, 0, 1e30)));
            // One path in sixteen is zero, and one in thirty-two has the opposite sign.
            if (seed % 16 == 0) amount = 0;
            if (exactOutput != (seed % 32 == 1)) amount = -amount;
            data = bytes.concat(data, _path(seed >> 8, amount));
        }
    }

    function _mutate(bytes memory data, uint256 seed) private pure returns (bytes memory) {
        uint256 kind = seed % 4;
        seed >>= 8;
        if (kind == 0) {
            // Truncate.
            uint256 length = seed % (data.length + 1);
            assembly ("memory-safe") {
                mstore(data, length)
            }
            return data;
        }
        if (kind == 1) {
            // Append.
            return bytes.concat(data, new bytes(1 + seed % 64));
        }
        // Rewrite one or two bytes.
        for (uint256 i; i < kind - 1; ++i) {
            data[seed % data.length] = bytes1(uint8(seed >> 64));
            seed = uint256(keccak256(abi.encode(seed)));
        }
        return data;
    }

    function _assertSame(bytes memory data, uint8 mode) private returns (bool success) {
        string memory candidate = vm.envOr("ROUTER_ARTIFACT", BASELINE);
        (bool baselineSuccess, bytes memory baselineResult, bytes32 baselineDigest) = _run(BASELINE, data, mode);
        (bool candidateSuccess, bytes memory candidateResult, bytes32 candidateDigest) = _run(candidate, data, mode);
        assertEq(candidateSuccess, baselineSuccess, "success flag");
        assertEq(candidateResult, baselineResult, "return data");
        assertEq(candidateDigest, baselineDigest, "forwarded payloads");
        return baselineSuccess;
    }

    function testFuzz_ValidRoutesMatchBaseline(uint256 seed, bool forwardedMode) external {
        _assertSame(_route(seed), forwardedMode ? 1 : 0);
    }

    function testFuzz_MutatedRoutesMatchBaseline(uint256 seed, uint256 mutation, bool forwardedMode) external {
        _assertSame(_mutate(_route(seed), mutation), forwardedMode ? 1 : 0);
    }

    function testFuzz_ArbitraryCalldataMatchesBaseline(bytes memory data, bool forwardedMode) external {
        _assertSame(data, forwardedMode ? 1 : 0);
    }

    /// @dev External so each generated route starts from fresh memory.
    function compareGenerated(uint256 index) external returns (bool success, uint256 length) {
        bytes memory data = _route(uint256(keccak256(abi.encode("route", index))));
        length = data.length;
        success = _assertSame(data, uint8(index & 1));
    }

    /// @dev Guards against a vacuous comparison: a healthy share of generated routes must succeed.
    function test_GeneratedRoutesMostlySucceed() external {
        uint256 succeeded;
        uint256 longSignatures;
        for (uint256 i; i < 200; ++i) {
            (bool success, uint256 length) = this.compareGenerated(i);
            if (length > 8000) ++longSignatures;
            if (success) ++succeeded;
        }
        emit log_named_uint("succeeded of 200", succeeded);
        emit log_named_uint("routes over 8000 bytes", longSignatures);
        assertGt(succeeded, 100, "valid route share");
        assertGt(longSignatures, 20, "long signature share");
    }

    /// @dev Prints every payload the forwardee received from each build for one generated route.
    function test_DebugSeed() external {
        bytes memory data = _route(vm.envOr("DEBUG_SEED", uint256(64)));
        string[2] memory artifacts = [BASELINE, vm.envOr("ROUTER_ARTIFACT", BASELINE)];
        for (uint256 a; a < 2; ++a) {
            vm.recordLogs();
            _run(artifacts[a], data, 1);
            Vm.Log[] memory logs = vm.getRecordedLogs();
            for (uint256 i; i < logs.length; ++i) {
                emit log_named_bytes(string.concat("payload-", vm.toString(a), "-", vm.toString(i)), logs[i].data);
            }
        }
    }
}
