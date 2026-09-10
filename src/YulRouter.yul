object "YulRouter" {
    code {
        let runtimeSize := datasize("Runtime")
        datacopy(0, dataoffset("Runtime"), runtimeSize)

        // Constructor arg: ABI-encoded Ekubo Core address appended to initcode.
        codecopy(runtimeSize, sub(codesize(), 0x20), 0x20)
        setimmutable(0, "core", mload(runtimeSize))
        setimmutable(0, "self", address())
        return(0, runtimeSize)
    }

    object "Runtime" {
        code {
            let core := loadimmutable("core")
            let self := loadimmutable("self")

            if iszero(eq(address(), self)) {
                revertSelector(0xa1c0d6e5) // DelegateCall()
            }

            if eq(caller(), core) {
                switch shr(224, calldataload(0))
                case 0 {
                    locked()
                }
                case 1 {
                    forwarded()
                }
                default {
                    revertSelector(0x48f5c3ed) // InvalidCaller()
                }
            }

            if eq(shr(224, calldataload(0)), 0xedfa3568) { // quote(bytes)
                quote(core)
            }

            lock(core)

            function lock(coreAddress) {
                let size := calldatasize()

                mstore(0, 0xf83d08ba) // lock()
                calldatacopy(32, 0, size)
                mstore(add(size, 32), caller())
                mstore(add(size, 64), callvalue())

                if iszero(call(gas(), coreAddress, 0, 28, add(size, 0x44), 28, 0x80)) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }

                return(28, 0x80)
            }

            function quote(coreAddress) {
                // Standard ABI encoding for quote(bytes): selector, offset, byte length, route data.
                if or(callvalue(), iszero(eq(calldataload(4), 0x20))) {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }

                let size := calldataload(0x24)
                // For a truncated header, equality below is possible only at calldata
                // lengths 4 or 36: the former fails the ABI offset check, and the latter
                // loads a zero size that cannot equal the wrapped available length.
                // For a complete header, size <= available rules out rounding overflow.
                let available := sub(calldatasize(), 0x44)
                if or(gt(size, available), iszero(eq(and(add(size, 31), not(31)), available))) {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }

                mstore(0, 0xf83d08ba) // lock()
                calldatacopy(32, 0x44, size)
                // The high bit cannot be present in a caller address, so it safely marks this lock as a quote.
                mstore(add(size, 32), or(caller(), shl(255, 1)))
                mstore(add(size, 64), 0)

                if call(gas(), coreAddress, 0, 28, add(size, 0x44), 0, 0) {
                    revertSelector(0x4d985756) // ExpectedQuoteRevert()
                }

                // Calls made while executing the quoted route wrap downstream failures with an
                // internal marker. Unwrap exactly one layer so arbitrary callees cannot forge an
                // unwrapped QuoteResult, while their original revert data still bubbles unchanged.
                if iszero(lt(returndatasize(), 0x20)) {
                    returndatacopy(0, 0, 0x20)
                    // keccak256("YulRouter.QuoteFailure.v1")
                    if eq(mload(0), 0xeff1c3af4643aab95042365a434f0e14df8d7fedb3d4d37c79a7b7ad890d567c) {
                        let downstreamSize := sub(returndatasize(), 0x20)
                        returndatacopy(0, 0x20, downstreamSize)
                        revert(0, downstreamSize)
                    }
                }

                if eq(returndatasize(), 0x84) {
                    // The failure-marker check above already copied the first word.
                    if eq(shr(224, mload(0)), 0x4852c8eb) { // QuoteResult(address,address,int256,int256)
                        returndatacopy(0, 4, 0x80)
                        return(0, 0x80)
                    }
                }

                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }

            // All route and settlement helpers below are reached only through authenticated
            // Core callbacks. caller() remains Core across downstream calls and reentrancy.
            function locked() {
                let routeEnd := sub(calldatasize(), 0x40)
                let specifiedToken, calculatedToken, totalSpecified, totalCalculated := executeRoute(routeEnd)
                let payerWithFlags := calldataload(routeEnd)

                if shr(160, payerWithFlags) {
                    mstore(0, 0x4852c8eb) // QuoteResult(address,address,int256,int256)
                    mstore(32, specifiedToken)
                    mstore(64, calculatedToken)
                    mstore(96, totalSpecified)
                    mstore(128, totalCalculated)
                    revert(28, 0x84)
                }

                // The quote branch above exits whenever any high payer bits are set.
                let payer := payerWithFlags
                let recipient := payer
                if and(byte(0, calldataload(0x24)), 1) {
                    recipient := shr(96, calldataload(0x5e))
                }

                let nativeRemaining := calldataload(add(routeEnd, 0x20))
                nativeRemaining := settle(specifiedToken, totalSpecified, payer, recipient, nativeRemaining)
                nativeRemaining := settle(calculatedToken, sub(0, totalCalculated), payer, recipient, nativeRemaining)

                if nativeRemaining {
                    if iszero(call(gas(), payer, nativeRemaining, 0, 0, 0, 0)) {
                        revertSelector(0xf4b3b1bc) // NativeTransferFailed()
                    }
                }

                mstore(0, specifiedToken)
                mstore(0x20, calculatedToken)
                mstore(0x40, totalSpecified)
                mstore(0x60, totalCalculated)
                return(0, 0x80)
            }

            function forwarded() {
                let specifiedToken, calculatedToken, totalSpecified, totalCalculated := executeRoute(calldatasize())

                // Return route amounts without settling. The original locker can derive the endpoint debt
                // changes as (totalSpecified, -totalCalculated) and combine them with another operation.
                mstore(0, specifiedToken)
                mstore(0x20, calculatedToken)
                mstore(0x40, totalSpecified)
                mstore(0x60, totalCalculated)
                return(0, 0x80)
            }

            function executeRoute(routeEnd) -> specifiedToken, calculatedToken, totalSpecified, totalCalculated {
                let offset := add(0x5e, mul(and(byte(0, calldataload(0x24)), 1), 20))

                let multiHopsRemaining := add(byte(1, calldataload(0x24)), 1)
                // The last nonzero specified amount records the route's sign; zero means unknown.
                let exactness

                specifiedToken := shr(96, calldataload(0x26))
                calculatedToken := shr(96, calldataload(0x3a))

                if gt(offset, routeEnd) {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }

                for { } multiHopsRemaining { multiHopsRemaining := sub(multiHopsRemaining, 1) } {
                    let currentToken := specifiedToken
                    let header := calldataload(offset)
                    let currentAmount := sar(128, header)
                    let hopsRemaining := add(byte(16, header), 1)
                    // Keep the original count for partial-fill validation as the loop counts down.
                    let hopCount := hopsRemaining
                    offset := add(offset, 17)

                    if gt(offset, routeEnd) {
                        revertSelector(0x84e505d2) // InvalidRoute()
                    }

                    totalSpecified := add(totalSpecified, currentAmount)

                    if currentAmount {
                        if exactness {
                            if slt(xor(exactness, currentAmount), 0) {
                                revertSelector(0x84e505d2) // InvalidRoute()
                            }
                        }
                        exactness := currentAmount
                    }

                    for { } hopsRemaining { hopsRemaining := sub(hopsRemaining, 1) } {
                        let hopType := byte(0, calldataload(offset))
                        offset := add(offset, 1)

                        switch hopType
                        case 0 {
                            let specifiedAdjustment
                            offset, currentAmount, currentToken, specifiedAdjustment := executeCoreSwapHop(
                                offset,
                                routeEnd,
                                currentAmount,
                                currentToken,
                                hopCount
                            )
                            totalSpecified := add(totalSpecified, specifiedAdjustment)
                        }
                        case 1 {
                            let specifiedAdjustment
                            offset, currentAmount, currentToken, specifiedAdjustment := executeForwardedSwapHop(
                                offset,
                                routeEnd,
                                currentAmount,
                                currentToken,
                                hopCount
                            )
                            totalSpecified := add(totalSpecified, specifiedAdjustment)
                        }
                        case 2 {
                            let underlying := shr(96, calldataload(offset))
                            let wrapped := shr(96, calldataload(add(offset, 20)))
                            offset := add(offset, 40)
                            if gt(offset, routeEnd) {
                                revertSelector(0x84e505d2) // InvalidRoute()
                            }

                            let forwardAmount := currentAmount
                            let tokenBeforeWrapper := currentToken
                            let isUnderlying := eq(tokenBeforeWrapper, underlying)
                            let isWrapped := eq(tokenBeforeWrapper, wrapped)

                            if iszero(or(isUnderlying, isWrapped)) {
                                revertSelector(0x84e505d2) // InvalidRoute()
                            }

                            currentToken := wrapped
                            if isWrapped {
                                forwardAmount := sub(0, currentAmount)
                                currentToken := underlying
                            }

                            forwardWrapper(wrapped, forwardAmount)
                        }
                        case 4 {
                            offset, currentAmount, currentToken :=
                                executeSignedSwapHop(offset, routeEnd, currentAmount, currentToken)
                        }
                        default {
                            revertSelector(0xee7d6c3a) // InvalidHopType()
                        }
                    }

                    if iszero(eq(currentToken, calculatedToken)) {
                        revertSelector(0x84e505d2) // InvalidRoute()
                    }

                    totalCalculated := add(totalCalculated, currentAmount)
                }

                if iszero(eq(offset, routeEnd)) {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }

                let threshold := sar(128, calldataload(0x4e))
                if threshold {
                    if exactness {
                        if slt(xor(threshold, exactness), 0) {
                            revertSelector(0x84e505d2) // InvalidRoute()
                        }
                    }
                }

                if slt(totalCalculated, threshold) {
                    mstore(0, 0xe65f682d) // SlippageCheckFailed(int256)
                    mstore(32, totalCalculated)
                    revert(28, 0x24)
                }
            }

            function resolveDirection(currentToken, token0, token1) -> isToken1 {
                isToken1 := eq(currentToken, token1)
                if iszero(or(isToken1, eq(currentToken, token0))) {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }
            }

            function validatePartialSwap(allowPartial, hopCount, amount) {
                // Path headers encode hopCount minus one, so hopCount is always positive.
                if and(allowPartial, or(gt(hopCount, 1), iszero(amount))) {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }
            }

            function executeCoreSwapHop(offset, routeEnd, currentAmount, currentToken, hopCount)
                -> nextOffset, nextAmount, nextToken, specifiedAdjustment
            {
                let token0 := shr(96, calldataload(offset))
                let token1 := shr(96, calldataload(add(offset, 20)))
                let config := calldataload(add(offset, 40))
                let options := calldataload(add(offset, 72))
                let sqrtRatioLimit := shr(160, options)
                let skipAhead := and(shr(128, options), 0xffffffff)
                nextOffset := add(offset, 88)
                if gt(nextOffset, routeEnd) {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }

                validatePartialSwap(shr(31, skipAhead), hopCount, currentAmount)
                let isToken1 := resolveDirection(currentToken, token0, token1)

                sqrtRatioLimit := resolveLimit(currentAmount, isToken1, sqrtRatioLimit)

                let update := coreSwap(
                    token0,
                    token1,
                    config,
                    currentAmount,
                    isToken1,
                    sqrtRatioLimit,
                    and(skipAhead, 0x7fffffff)
                )
                nextAmount, nextToken, specifiedAdjustment :=
                    nextFromUpdate(update, currentAmount, isToken1, token0, token1, shr(31, skipAhead))
            }

            function executeForwardedSwapHop(offset, routeEnd, currentAmount, currentToken, hopCount)
                -> nextOffset, nextAmount, nextToken, specifiedAdjustment
            {
                if gt(add(offset, 108), routeEnd) {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }
                let forwardee := shr(96, calldataload(offset))
                let token0 := shr(96, calldataload(add(offset, 20)))
                let token1 := shr(96, calldataload(add(offset, 40)))
                let config := calldataload(add(offset, 60))
                let options := calldataload(add(offset, 92))
                let sqrtRatioLimit := shr(160, options)
                let skipAhead := and(shr(128, options), 0xffffffff)
                nextOffset := add(offset, 108)

                validatePartialSwap(shr(31, skipAhead), hopCount, currentAmount)
                let isToken1 := resolveDirection(currentToken, token0, token1)

                sqrtRatioLimit := resolveLimit(currentAmount, isToken1, sqrtRatioLimit)

                let update := forwardedSwap(
                    forwardee,
                    token0,
                    token1,
                    config,
                    currentAmount,
                    isToken1,
                    sqrtRatioLimit,
                    and(skipAhead, 0x7fffffff)
                )
                nextAmount, nextToken, specifiedAdjustment :=
                    nextFromUpdate(update, currentAmount, isToken1, token0, token1, shr(31, skipAhead))
            }

            function executeSignedSwapHop(offset, routeEnd, currentAmount, currentToken)
                -> nextOffset, nextAmount, nextToken
            {
                if gt(add(offset, 176), routeEnd) {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }
                let forwardee := shr(96, calldataload(offset))
                let token0 := shr(96, calldataload(add(offset, 20)))
                let token1 := shr(96, calldataload(add(offset, 40)))
                let config := calldataload(add(offset, 60))
                let sqrtRatioLimit := shr(160, calldataload(add(offset, 92)))
                let skipAhead := and(shr(224, calldataload(add(offset, 104))), 0x7fffffff)
                let signatureLength := shr(224, calldataload(add(offset, 172)))
                let signatureOffset := add(offset, 176)
                nextOffset := add(signatureOffset, signatureLength)

                if or(gt(nextOffset, routeEnd), lt(nextOffset, signatureOffset)) {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }

                let isToken1 := resolveDirection(currentToken, token0, token1)

                sqrtRatioLimit := resolveLimit(currentAmount, isToken1, sqrtRatioLimit)

                let update := signedExclusiveSwap(
                    forwardee,
                    token0,
                    token1,
                    config,
                    currentAmount,
                    isToken1,
                    sqrtRatioLimit,
                    skipAhead,
                    signatureOffset,
                    signatureLength
                )
                nextAmount, nextToken := nextFromUpdateExact(update, currentAmount, isToken1, token0, token1)
            }

            function resolveLimit(amount, isToken1, limit) -> resolved {
                // Select MIN/MAX via their XOR difference, then use it only for a zero limit.
                resolved := or(limit, mul(iszero(limit), xor(0x400065a8177fae27, mul(xor(slt(amount, 0), isToken1), 0xffff9a58c9f7f0ae8d3e0684))))
            }

            function packParams(amount, isToken1, sqrtRatioLimit, skipAhead) -> params {
                params := shl(160, sqrtRatioLimit)
                params := or(params, shl(32, and(amount, 0xffffffffffffffffffffffffffffffff)))
                params := or(params, or(shl(31, isToken1), skipAhead))
            }

            function coreSwap(token0, token1, config, amount, isToken1, sqrtRatioLimit, skipAhead) -> update {
                mstore(0, 0) // swap_6269342730()
                mstore(4, token0)
                mstore(0x24, token1)
                mstore(0x44, config)
                mstore(0x64, packParams(amount, isToken1, sqrtRatioLimit, skipAhead))

                if iszero(call(gas(), caller(), 0, 0, 132, 0, 64)) {
                    revertExternalCall(0)
                }

                update := mload(0)
            }

            function forwardedSwap(forwardee, token0, token1, config, amount, isToken1, sqrtRatioLimit, skipAhead) -> update {
                mstore(0, 0x101e8952) // forward(address)
                mstore(32, forwardee)
                mstore(64, token0)
                mstore(96, token1)
                mstore(128, config)
                mstore(160, packParams(amount, isToken1, sqrtRatioLimit, skipAhead))

                if iszero(call(gas(), caller(), 0, 28, 164, 28, 64)) {
                    revertExternalCall(0)
                }
                if lt(returndatasize(), 32) {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }

                update := mload(28)
            }

            function signedExclusiveSwap(
                forwardee,
                token0,
                token1,
                config,
                amount,
                isToken1,
                sqrtRatioLimit,
                skipAhead,
                signatureOffset,
                signatureLength
            ) -> update {
                let ptr := 28
                let dataPtr := add(ptr, 36)
                let signaturePtr := add(dataPtr, 0x100)
                let paddedSignatureLength := and(add(signatureLength, 31), not(31))

                mstore(0, 0x101e8952) // forward(address)
                mstore(add(ptr, 4), forwardee)

                // abi.encode(PoolKey, SwapParameters, SignedSwapMeta, PoolBalanceUpdate, bytes)
                mstore(dataPtr, token0)
                mstore(add(dataPtr, 0x20), token1)
                mstore(add(dataPtr, 0x40), config)
                mstore(add(dataPtr, 0x60), packParams(amount, isToken1, sqrtRatioLimit, skipAhead))
                // meta and minBalanceUpdate are consecutive calldata words, before the signature length.
                calldatacopy(add(dataPtr, 0x80), sub(signatureOffset, 68), 64)
                mstore(add(dataPtr, 0xc0), 0xe0)
                mstore(add(dataPtr, 0xe0), signatureLength)
                mstore(sub(add(signaturePtr, paddedSignatureLength), 32), 0)
                calldatacopy(signaturePtr, signatureOffset, signatureLength)

                if iszero(call(gas(), caller(), 0, ptr, add(0x124, paddedSignatureLength), ptr, 64)) {
                    revertExternalCall(0)
                }
                if lt(returndatasize(), 32) {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }

                update := mload(ptr)
            }

            function forwardWrapper(wrapper, amount) {
                mstore(0, 0x101e8952) // forward(address)
                mstore(32, wrapper)
                mstore(64, amount)

                if iszero(call(gas(), caller(), 0, 28, 68, 0, 0)) {
                    revertExternalCall(0)
                }
            }

            function nextFromUpdate(update, amount, isToken1, token0, token1, allowPartial)
                -> nextAmount, nextToken, specifiedAdjustment
            {
                // Partial fills compare nonnegative magnitudes. A wrong-sign delta wraps
                // above the bounded int128 magnitude and fails the unsigned comparison.
                if isToken1 {
                    let delta1 := signextend(15, update)
                    switch allowPartial
                    case 0 {
                        if iszero(eq(delta1, amount)) {
                            revertSelector(0xe3648855) // PartialSwapsDisallowed()
                        }
                    }
                    default {
                        specifiedAdjustment := sub(delta1, amount)
                        switch slt(amount, 0)
                        case 0 {
                            if gt(delta1, amount) {
                                revertSelector(0xe3648855) // PartialSwapsDisallowed()
                            }
                        }
                        default {
                            if gt(sub(0, delta1), sub(0, amount)) {
                                revertSelector(0xe3648855) // PartialSwapsDisallowed()
                            }
                        }
                    }
                    let delta0 := sar(128, update)
                    nextAmount := sub(0, delta0)
                    nextToken := token0
                    leave
                }

                let delta0 := sar(128, update)
                switch allowPartial
                case 0 {
                    if iszero(eq(delta0, amount)) {
                        revertSelector(0xe3648855) // PartialSwapsDisallowed()
                    }
                }
                default {
                    specifiedAdjustment := sub(delta0, amount)
                    switch slt(amount, 0)
                    case 0 {
                        if gt(delta0, amount) {
                            revertSelector(0xe3648855) // PartialSwapsDisallowed()
                        }
                    }
                    default {
                        if gt(sub(0, delta0), sub(0, amount)) {
                            revertSelector(0xe3648855) // PartialSwapsDisallowed()
                        }
                    }
                }
                let delta1 := signextend(15, update)
                nextAmount := sub(0, delta1)
                nextToken := token1
            }

            function nextFromUpdateExact(update, amount, isToken1, token0, token1) -> nextAmount, nextToken {
                let specifiedDelta := sar(128, update)
                let calculatedDelta := signextend(15, update)
                nextToken := token1
                if isToken1 {
                    specifiedDelta := calculatedDelta
                    calculatedDelta := sar(128, update)
                    nextToken := token0
                }
                if iszero(eq(specifiedDelta, amount)) {
                    revertSelector(0xe3648855) // PartialSwapsDisallowed()
                }
                nextAmount := sub(0, calculatedDelta)
            }

            function settle(token, signedAmount, payer, recipient, nativeRemaining) -> updatedNativeRemaining {
                if sgt(signedAmount, 0) {
                    updatedNativeRemaining := pay(token, payer, signedAmount, nativeRemaining)
                    leave
                }

                if slt(signedAmount, 0) {
                    withdraw(token, recipient, sub(0, signedAmount))
                }
                updatedNativeRemaining := nativeRemaining
            }

            function pay(token, payer, amount, nativeRemaining) -> updatedNativeRemaining {
                switch token
                case 0 {
                    if gt(amount, nativeRemaining) {
                        revertSelector(0x84e505d2) // InvalidRoute()
                    }

                    if iszero(call(gas(), caller(), amount, 0, 0, 0, 0)) {
                        revertSelector(0xf4b3b1bc) // NativeTransferFailed()
                    }

                    updatedNativeRemaining := sub(nativeRemaining, amount)
                }
                default {
                    payErc20(payer, token, amount)
                    updatedNativeRemaining := nativeRemaining
                }
            }

            function payErc20(payer, token, amount) {
                // The ABI buffer starts at byte 28 so selectors need no shift. Return
                // data overlays that same buffer, preserving short-return semantics.
                // startPayments(token)
                mstore(0, 0xf9b6a796)
                mstore(32, token)
                pop(call(gas(), caller(), 0, 28, 36, 0, 0))

                mstore(0, 0x23b872dd) // transferFrom(address,address,uint256)
                mstore(32, payer)
                mstore(64, caller())
                mstore(96, amount)

                let success := call(gas(), token, 0, 28, 100, 28, 32)
                if iszero(and(success, or(iszero(returndatasize()), eq(mload(28), 1)))) {
                    if returndatasize() {
                        returndatacopy(0, 0, returndatasize())
                        revert(0, returndatasize())
                    }
                    revertSelector(0x7939f424) // TransferFromFailed()
                }

                // completePayments(token)
                mstore(0, 0x12e103f1)
                mstore(32, token)
                pop(call(gas(), caller(), 0, 28, 36, 0, 0))
            }

            function withdraw(token, recipient, amount) {
                // Write backwards: later stores replace only padding/high amount bits.
                // Bytes 8..67 hold selector (4), token (20), recipient (20), amount (16).
                mstore(36, amount)
                mstore(20, recipient)
                mstore(0, or(shl(160, 0x3ccfd60b), token))

                if iszero(call(gas(), caller(), 0, 8, 60, 0, 0)) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }
            }

            function revertExternalCall(ptr) {
                let size := returndatasize()

                // A selector-zero callback with high payer bits is the quote lock callback.
                // Prefixing every downstream failure in that context gives quote() an
                // origin-authenticated boundary: even if a callee returns this marker or a
                // QuoteResult payload, it receives another marker before reaching quote().
                let payerWithFlags := calldataload(sub(calldatasize(), 0x40))
                if and(
                    iszero(shr(224, calldataload(0))),
                    iszero(iszero(shr(160, payerWithFlags)))
                ) {
                    // keccak256("YulRouter.QuoteFailure.v1")
                    mstore(ptr, 0xeff1c3af4643aab95042365a434f0e14df8d7fedb3d4d37c79a7b7ad890d567c)
                    returndatacopy(add(ptr, 0x20), 0, size)
                    revert(ptr, add(size, 0x20))
                }

                returndatacopy(ptr, 0, size)
                revert(ptr, size)
            }

            function revertSelector(selector) {
                mstore(0, selector)
                revert(28, 4)
            }
        }
    }
}
