object "YulRouter" {
    code {
        let runtimeSize := datasize("Runtime")
        datacopy(0, dataoffset("Runtime"), runtimeSize)

        // Constructor arg: ABI-encoded Ekubo Core address appended to initcode.
        codecopy(runtimeSize, sub(codesize(), 0x20), 0x20)
        // The runtime compares this immutable address with ADDRESS to reject delegatecall.
        mstore(add(runtimeSize, 0x20), address())

        return(0, add(runtimeSize, 0x40))
    }

    object "Runtime" {
        code {
            codecopy(0, sub(codesize(), 0x40), 0x40)
            let core := mload(0)
            let self := mload(0x20)

            if iszero(eq(address(), self)) {
                revertSelector(0xa1c0d6e5) // DelegateCall()
            }

            if eq(caller(), core) {
                switch shr(224, calldataload(0))
                case 0 {
                    locked(core)
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

                mstore(0, shl(224, 0xf83d08ba)) // lock()
                calldatacopy(4, 0, size)
                mstore(add(size, 4), caller())
                mstore(add(size, 0x24), callvalue())

                if iszero(call(gas(), coreAddress, 0, 0, add(size, 0x44), 0, 0x80)) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }

                return(0, 0x80)
            }

            function quote(coreAddress) {
                // Standard ABI encoding for quote(bytes): selector, offset, byte length, route data.
                if or(lt(calldatasize(), 0x44), iszero(eq(calldataload(4), 0x20))) {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }
                if callvalue() {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }

                let size := calldataload(0x24)
                let sizeWithPadding := add(size, 31)
                if lt(sizeWithPadding, size) {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }
                let paddedSize := and(sizeWithPadding, not(31))
                let encodedSize := add(0x44, paddedSize)
                if or(lt(encodedSize, paddedSize), iszero(eq(calldatasize(), encodedSize))) {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }

                mstore(0, shl(224, 0xf83d08ba)) // lock()
                calldatacopy(4, 0x44, size)
                // The high bit cannot be present in a caller address, so it safely marks this lock as a quote.
                mstore(add(size, 4), or(caller(), shl(255, 1)))
                mstore(add(size, 0x24), 0)

                if call(gas(), coreAddress, 0, 0, add(size, 0x44), 0, 0) {
                    revertSelector(0x4d985756) // ExpectedQuoteRevert()
                }

                if eq(returndatasize(), 0x84) {
                    returndatacopy(0, 0, 0x20)
                    if eq(shr(224, mload(0)), 0x4852c8eb) { // QuoteResult(address,address,int256,int256)
                        returndatacopy(0, 4, 0x80)
                        return(0, 0x80)
                    }
                }

                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }

            function locked(coreAddress) {
                let routeEnd := sub(calldatasize(), 0x40)
                let specifiedToken, calculatedToken, totalSpecified, totalCalculated := executeRoute()
                let payerWithFlags := calldataload(routeEnd)
                let payer := and(payerWithFlags, 0xffffffffffffffffffffffffffffffffffffffff)

                if shr(160, payerWithFlags) {
                    mstore(0, shl(224, 0x4852c8eb)) // QuoteResult(address,address,int256,int256)
                    mstore(4, specifiedToken)
                    mstore(0x24, calculatedToken)
                    mstore(0x44, totalSpecified)
                    mstore(0x64, totalCalculated)
                    revert(0, 0x84)
                }

                let recipient := payer
                if and(byte(0, calldataload(0x24)), 1) {
                    recipient := shr(96, calldataload(0x5e))
                }

                let nativeRemaining := calldataload(add(routeEnd, 0x20))
                nativeRemaining := settle(
                    coreAddress, specifiedToken, totalSpecified, payer, recipient, nativeRemaining
                )
                nativeRemaining := settle(
                    coreAddress, calculatedToken, sub(0, totalCalculated), payer, recipient, nativeRemaining
                )

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
                let specifiedToken, calculatedToken, totalSpecified, totalCalculated := executeRoute()

                // Return route amounts without settling. The original locker can derive the endpoint debt
                // changes as (totalSpecified, -totalCalculated) and combine them with another operation.
                mstore(0, specifiedToken)
                mstore(0x20, calculatedToken)
                mstore(0x40, totalSpecified)
                mstore(0x60, totalCalculated)
                return(0, 0x80)
            }

            function executeRoute() -> specifiedToken, calculatedToken, totalSpecified, totalCalculated {
                let routeEnd := sub(calldatasize(), shl(6, iszero(shr(224, calldataload(0)))))

                let offset := 0x5e

                // The low 16 bits track remaining multi-hops. Bits 16-17 track exactness:
                // 0 is unknown/all zero, 1 is exact input, and 2 is exact output. Bits 18-26
                // cache the current multi-hop's original hop count for partial-fill validation.
                let multiHopState := add(byte(1, calldataload(0x24)), 1)

                specifiedToken := shr(96, calldataload(0x26))
                calculatedToken := shr(96, calldataload(0x3a))

                switch and(byte(0, calldataload(0x24)), 1)
                case 0 {
                    if gt(0x5e, routeEnd) {
                        revertSelector(0x84e505d2) // InvalidRoute()
                    }
                }
                default {
                    if gt(0x72, routeEnd) {
                        revertSelector(0x84e505d2) // InvalidRoute()
                    }
                    offset := 0x72
                }

                for { } and(multiHopState, 0xffff) { multiHopState := sub(multiHopState, 1) } {
                    let currentToken := specifiedToken
                    let currentAmount := sar(128, calldataload(offset))
                    offset := add(offset, 16)
                    let hopsRemaining := add(byte(0, calldataload(offset)), 1)
                    multiHopState := or(and(multiHopState, 0x3ffff), shl(18, hopsRemaining))
                    offset := add(offset, 1)

                    if gt(offset, routeEnd) {
                        revertSelector(0x84e505d2) // InvalidRoute()
                    }

                    totalSpecified := add(totalSpecified, currentAmount)

                    if currentAmount {
                        let routeExactness := add(slt(currentAmount, 0), 1)
                        let exactness := and(shr(16, multiHopState), 3)
                        if and(exactness, iszero(eq(exactness, routeExactness))) {
                            revertSelector(0x84e505d2) // InvalidRoute()
                        }
                        multiHopState := or(and(multiHopState, not(0x30000)), shl(16, routeExactness))
                    }

                    for { } hopsRemaining { hopsRemaining := sub(hopsRemaining, 1) } {
                        let hopType := byte(0, calldataload(offset))
                        offset := add(offset, 1)

                        switch hopType
                        case 0 {
                            let specifiedAdjustment
                            offset, currentAmount, currentToken, specifiedAdjustment := executeCoreSwapHop(
                                caller(),
                                offset,
                                routeEnd,
                                currentAmount,
                                currentToken,
                                and(shr(18, multiHopState), 0x1ff)
                            )
                            totalSpecified := add(totalSpecified, specifiedAdjustment)
                        }
                        case 1 {
                            let specifiedAdjustment
                            offset, currentAmount, currentToken, specifiedAdjustment := executeForwardedSwapHop(
                                caller(),
                                offset,
                                routeEnd,
                                currentAmount,
                                currentToken,
                                and(shr(18, multiHopState), 0x1ff)
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

                            forwardWrapper(caller(), wrapped, forwardAmount)
                        }
                        case 4 {
                            offset, currentAmount, currentToken :=
                                executeSignedSwapHop(caller(), offset, routeEnd, currentAmount, currentToken)
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
                let exactness := and(shr(16, multiHopState), 3)
                if threshold {
                    if exactness {
                        if xor(slt(threshold, 0), eq(exactness, 2)) {
                            revertSelector(0x84e505d2) // InvalidRoute()
                        }
                    }
                }

                if slt(totalCalculated, threshold) {
                    mstore(0, shl(224, 0xe65f682d)) // SlippageCheckFailed(int256)
                    mstore(4, totalCalculated)
                    revert(0, 0x24)
                }
            }

            function resolveDirection(currentToken, token0, token1) -> isToken1 {
                if eq(currentToken, token0) {
                    isToken1 := eq(token0, token1)
                    leave
                }
                if eq(currentToken, token1) {
                    isToken1 := 1
                    leave
                }
                revertSelector(0x84e505d2) // InvalidRoute()
            }

            function validatePartialSwap(allowPartial, hopCount, amount) {
                if and(allowPartial, or(iszero(eq(hopCount, 1)), iszero(amount))) {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }
            }

            function executeCoreSwapHop(coreAddress, offset, routeEnd, currentAmount, currentToken, hopCount)
                -> nextOffset, nextAmount, nextToken, specifiedAdjustment
            {
                let token0 := shr(96, calldataload(offset))
                let token1 := shr(96, calldataload(add(offset, 20)))
                let config := calldataload(add(offset, 40))
                let sqrtRatioLimit := shr(160, calldataload(add(offset, 72)))
                let skipAhead := shr(224, calldataload(add(offset, 84)))
                nextOffset := add(offset, 88)
                if gt(nextOffset, routeEnd) {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }

                validatePartialSwap(shr(31, skipAhead), hopCount, currentAmount)
                let isToken1 := resolveDirection(currentToken, token0, token1)

                if iszero(sqrtRatioLimit) {
                    sqrtRatioLimit := 0x00000000400065a8177fae27
                    if xor(slt(currentAmount, 0), isToken1) {
                        sqrtRatioLimit := 0xffff9a5889f795069a41a8a3
                    }
                }

                let update := coreSwap(
                    coreAddress,
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

            function executeForwardedSwapHop(coreAddress, offset, routeEnd, currentAmount, currentToken, hopCount)
                -> nextOffset, nextAmount, nextToken, specifiedAdjustment
            {
                if gt(add(offset, 108), routeEnd) {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }
                let forwardee := shr(96, calldataload(offset))
                let token0 := shr(96, calldataload(add(offset, 20)))
                let token1 := shr(96, calldataload(add(offset, 40)))
                let config := calldataload(add(offset, 60))
                let sqrtRatioLimit := shr(160, calldataload(add(offset, 92)))
                let skipAhead := shr(224, calldataload(add(offset, 104)))
                nextOffset := add(offset, 108)

                validatePartialSwap(shr(31, skipAhead), hopCount, currentAmount)
                let isToken1 := resolveDirection(currentToken, token0, token1)

                if iszero(sqrtRatioLimit) {
                    sqrtRatioLimit := 0x00000000400065a8177fae27
                    if xor(slt(currentAmount, 0), isToken1) {
                        sqrtRatioLimit := 0xffff9a5889f795069a41a8a3
                    }
                }

                let update := forwardedSwap(
                    coreAddress,
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

            function executeSignedSwapHop(coreAddress, offset, routeEnd, currentAmount, currentToken)
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
                let meta := calldataload(add(offset, 108))
                let minBalanceUpdate := calldataload(add(offset, 140))
                let signatureLength := shr(224, calldataload(add(offset, 172)))
                let signatureOffset := add(offset, 176)
                nextOffset := add(signatureOffset, signatureLength)

                if or(gt(nextOffset, routeEnd), lt(nextOffset, signatureOffset)) {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }

                let isToken1 := resolveDirection(currentToken, token0, token1)

                if iszero(sqrtRatioLimit) {
                    sqrtRatioLimit := 0x00000000400065a8177fae27
                    if xor(slt(currentAmount, 0), isToken1) {
                        sqrtRatioLimit := 0xffff9a5889f795069a41a8a3
                    }
                }

                let update := signedExclusiveSwap(
                    coreAddress,
                    forwardee,
                    token0,
                    token1,
                    config,
                    currentAmount,
                    isToken1,
                    sqrtRatioLimit,
                    skipAhead,
                    meta,
                    minBalanceUpdate,
                    signatureOffset,
                    signatureLength
                )
                nextAmount, nextToken := nextFromUpdateExact(update, currentAmount, isToken1, token0, token1)
            }

            function packParams(amount, isToken1, sqrtRatioLimit, skipAhead) -> params {
                params := shl(160, sqrtRatioLimit)
                params := or(params, shl(32, and(amount, 0xffffffffffffffffffffffffffffffff)))
                params := or(params, or(shl(31, isToken1), skipAhead))
            }

            function coreSwap(coreAddress, token0, token1, config, amount, isToken1, sqrtRatioLimit, skipAhead) -> update {
                mstore(0x60, 0) // swap_6269342730()
                mstore(0x64, token0)
                mstore(0x84, token1)
                mstore(0xa4, config)
                mstore(0xc4, packParams(amount, isToken1, sqrtRatioLimit, skipAhead))

                if iszero(call(gas(), coreAddress, 0, 0x60, 132, 0x60, 64)) {
                    returndatacopy(0x60, 0, returndatasize())
                    revert(0x60, returndatasize())
                }

                update := mload(0x60)
            }

            function forwardedSwap(coreAddress, forwardee, token0, token1, config, amount, isToken1, sqrtRatioLimit, skipAhead) -> update {
                mstore(0x60, shl(224, 0x101e8952)) // forward(address)
                mstore(0x64, forwardee)
                mstore(0x84, token0)
                mstore(0xa4, token1)
                mstore(0xc4, config)
                mstore(0xe4, packParams(amount, isToken1, sqrtRatioLimit, skipAhead))

                if iszero(call(gas(), coreAddress, 0, 0x60, 164, 0x60, 64)) {
                    returndatacopy(0x60, 0, returndatasize())
                    revert(0x60, returndatasize())
                }
                if lt(returndatasize(), 32) {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }

                update := mload(0x60)
            }

            function signedExclusiveSwap(
                coreAddress,
                forwardee,
                token0,
                token1,
                config,
                amount,
                isToken1,
                sqrtRatioLimit,
                skipAhead,
                meta,
                minBalanceUpdate,
                signatureOffset,
                signatureLength
            ) -> update {
                let ptr := 0x60
                let dataPtr := add(ptr, 36)
                let signaturePtr := add(dataPtr, 0x100)
                let paddedSignatureLength := and(add(signatureLength, 31), not(31))

                mstore(ptr, shl(224, 0x101e8952)) // forward(address)
                mstore(add(ptr, 4), forwardee)

                // abi.encode(PoolKey, SwapParameters, SignedSwapMeta, PoolBalanceUpdate, bytes)
                mstore(dataPtr, token0)
                mstore(add(dataPtr, 0x20), token1)
                mstore(add(dataPtr, 0x40), config)
                mstore(add(dataPtr, 0x60), packParams(amount, isToken1, sqrtRatioLimit, skipAhead))
                mstore(add(dataPtr, 0x80), meta)
                mstore(add(dataPtr, 0xa0), minBalanceUpdate)
                mstore(add(dataPtr, 0xc0), 0xe0)
                mstore(add(dataPtr, 0xe0), signatureLength)
                calldatacopy(signaturePtr, signatureOffset, signatureLength)
                mstore(add(signaturePtr, signatureLength), 0)

                if iszero(call(gas(), coreAddress, 0, ptr, add(0x124, paddedSignatureLength), ptr, 64)) {
                    returndatacopy(ptr, 0, returndatasize())
                    revert(ptr, returndatasize())
                }
                if lt(returndatasize(), 32) {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }

                update := mload(ptr)
            }

            function forwardWrapper(coreAddress, wrapper, amount) {
                mstore(0, shl(224, 0x101e8952)) // forward(address)
                mstore(4, wrapper)
                mstore(36, amount)

                if iszero(call(gas(), coreAddress, 0, 0, 68, 0, 0)) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }
            }

            function nextFromUpdate(update, amount, isToken1, token0, token1, allowPartial)
                -> nextAmount, nextToken, specifiedAdjustment
            {
                if isToken1 {
                    let delta1 := signextend(15, update)
                    switch allowPartial
                    case 0 {
                        if iszero(eq(delta1, amount)) {
                            revertSelector(0xe3648855) // PartialSwapsDisallowed()
                        }
                    }
                    default {
                        switch slt(amount, 0)
                        case 0 {
                            if or(slt(delta1, 0), sgt(delta1, amount)) {
                                revertSelector(0xe3648855) // PartialSwapsDisallowed()
                            }
                        }
                        default {
                            if or(slt(delta1, amount), sgt(delta1, 0)) {
                                revertSelector(0xe3648855) // PartialSwapsDisallowed()
                            }
                        }
                    }
                    let delta0 := sar(128, update)
                    nextAmount := sub(0, delta0)
                    nextToken := token0
                    specifiedAdjustment := sub(delta1, amount)
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
                    switch slt(amount, 0)
                    case 0 {
                        if or(slt(delta0, 0), sgt(delta0, amount)) {
                            revertSelector(0xe3648855) // PartialSwapsDisallowed()
                        }
                    }
                    default {
                        if or(slt(delta0, amount), sgt(delta0, 0)) {
                            revertSelector(0xe3648855) // PartialSwapsDisallowed()
                        }
                    }
                }
                let delta1 := signextend(15, update)
                nextAmount := sub(0, delta1)
                nextToken := token1
                specifiedAdjustment := sub(delta0, amount)
            }

            function nextFromUpdateExact(update, amount, isToken1, token0, token1) -> nextAmount, nextToken {
                let specifiedAdjustment
                nextAmount, nextToken, specifiedAdjustment := nextFromUpdate(update, amount, isToken1, token0, token1, 0)
            }

            function settle(coreAddress, token, signedAmount, payer, recipient, nativeRemaining) -> updatedNativeRemaining {
                if sgt(signedAmount, 0) {
                    updatedNativeRemaining := pay(coreAddress, token, payer, signedAmount, nativeRemaining)
                    leave
                }

                if slt(signedAmount, 0) {
                    withdraw(coreAddress, token, recipient, sub(0, signedAmount))
                }
                updatedNativeRemaining := nativeRemaining
            }

            function pay(coreAddress, token, payer, amount, nativeRemaining) -> updatedNativeRemaining {
                switch token
                case 0 {
                    if gt(amount, nativeRemaining) {
                        revertSelector(0x84e505d2) // InvalidRoute()
                    }

                    if iszero(call(gas(), coreAddress, amount, 0, 0, 0, 0)) {
                        revertSelector(0xf4b3b1bc) // NativeTransferFailed()
                    }

                    updatedNativeRemaining := sub(nativeRemaining, amount)
                }
                default {
                    payErc20(coreAddress, payer, token, amount)
                    updatedNativeRemaining := nativeRemaining
                }
            }

            function payErc20(coreAddress, payer, token, amount) {
                // startPayments(token)
                mstore(0, shl(224, 0xf9b6a796))
                mstore(4, token)
                pop(call(gas(), coreAddress, 0, 0, 36, 0, 0))

                mstore(0, shl(224, 0x23b872dd)) // transferFrom(address,address,uint256)
                mstore(4, payer)
                mstore(36, coreAddress)
                mstore(68, amount)

                let success := call(gas(), token, 0, 0, 100, 0, 32)
                if iszero(and(success, or(iszero(returndatasize()), eq(mload(0), 1)))) {
                    if returndatasize() {
                        returndatacopy(0, 0, returndatasize())
                        revert(0, returndatasize())
                    }
                    revertSelector(0x7939f424) // TransferFromFailed()
                }

                // completePayments(token)
                mstore(0, shl(224, 0x12e103f1))
                mstore(4, token)
                pop(call(gas(), coreAddress, 0, 0, 36, 0, 0))
            }

            function withdraw(coreAddress, token, recipient, amount) {
                mstore(0, shl(224, 0x3ccfd60b)) // withdraw()
                mstore(4, shl(96, token))
                mstore(24, shl(96, recipient))
                mstore(44, shl(128, amount))

                if iszero(call(gas(), coreAddress, 0, 0, 60, 0, 0)) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }
            }

            function revertSelector(selector) {
                mstore(0, shl(224, selector))
                revert(0, 4)
            }
        }
    }
}
