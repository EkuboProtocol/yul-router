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
                    revertSelector(0x99f22abd) // ForwardNotAllowed()
                }
                default {
                    revertSelector(0x48f5c3ed) // InvalidCaller()
                }
            }

            lock(core)

            function lock(coreAddress) {
                let size := calldatasize()

                mstore(0, shl(224, 0xf83d08ba)) // lock()
                calldatacopy(4, 0, size)
                mstore(add(size, 4), caller())
                mstore(add(size, 0x24), callvalue())

                if iszero(call(gas(), coreAddress, 0, 0, add(size, 0x44), 0, 0x20)) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }

                return(0, 0x20)
            }

            function locked(coreAddress) {
                let minSqrtRatio := 0x00000000400065a8177fae27
                let maxSqrtRatio := 0xffff9a5889f795069a41a8a3

                let routeEnd := sub(calldatasize(), 0x40)
                let payer := calldataload(routeEnd)
                let nativeRemaining := calldataload(add(routeEnd, 0x20))

                let offset := 0x24

                let flagsWord := calldataload(0x24)
                let hasRecipient := and(byte(0, flagsWord), 1)
                let multiHopsRemaining := add(byte(1, flagsWord), 1)

                let specifiedToken := shr(96, calldataload(0x26))
                let calculatedToken := shr(96, calldataload(0x3a))
                let threshold := sar(128, calldataload(0x4e))
                offset := 0x5e

                let recipient := payer
                switch hasRecipient
                case 0 {
                    if gt(0x5e, routeEnd) {
                        revertSelector(0x84e505d2) // InvalidRoute()
                    }
                }
                default {
                    if gt(0x72, routeEnd) {
                        revertSelector(0x84e505d2) // InvalidRoute()
                    }
                    recipient := shr(96, calldataload(0x5e))
                    offset := 0x72
                }

                let totalSpecified := 0
                let totalCalculated := 0
                let exactOutKnown := 0
                let exactOut := 0

                for { } multiHopsRemaining { multiHopsRemaining := sub(multiHopsRemaining, 1) } {
                    let currentToken := specifiedToken
                    let currentAmount := sar(128, calldataload(offset))
                    offset := add(offset, 16)
                    let hopsRemaining := add(byte(0, calldataload(offset)), 1)
                    offset := add(offset, 1)

                    if gt(offset, routeEnd) {
                        revertSelector(0x84e505d2) // InvalidRoute()
                    }

                    totalSpecified := add(totalSpecified, currentAmount)

                    if currentAmount {
                        let routeExactOut := slt(currentAmount, 0)
                        if and(exactOutKnown, xor(exactOut, routeExactOut)) {
                            revertSelector(0x84e505d2) // InvalidRoute()
                        }
                        exactOutKnown := 1
                        exactOut := routeExactOut
                    }

                    for { } hopsRemaining { hopsRemaining := sub(hopsRemaining, 1) } {
                        let hopType := byte(0, calldataload(offset))
                        offset := add(offset, 1)

                        switch hopType
                        case 0 {
                            let token0 := shr(96, calldataload(offset))
                            let token1 := shr(96, calldataload(add(offset, 20)))
                            let config := calldataload(add(offset, 40))
                            let sqrtRatioLimit := shr(160, calldataload(add(offset, 72)))
                            let skipAhead := and(shr(224, calldataload(add(offset, 84))), 0x7fffffff)
                            offset := add(offset, 88)
                            if gt(offset, routeEnd) {
                                revertSelector(0x84e505d2) // InvalidRoute()
                            }

                            let isToken1 := resolveDirection(currentToken, token0, token1)

                            if iszero(sqrtRatioLimit) {
                                sqrtRatioLimit := minSqrtRatio
                                if xor(slt(currentAmount, 0), isToken1) {
                                    sqrtRatioLimit := maxSqrtRatio
                                }
                            }

                            let update := coreSwap(coreAddress, token0, token1, config, currentAmount, isToken1, sqrtRatioLimit, skipAhead)
                            currentAmount, currentToken := nextFromUpdate(update, currentAmount, isToken1, token0, token1)
                        }
                        case 1 {
                            if gt(add(offset, 108), routeEnd) {
                                revertSelector(0x84e505d2) // InvalidRoute()
                            }
                            let forwardee := shr(96, calldataload(offset))
                            let token0 := shr(96, calldataload(add(offset, 20)))
                            let token1 := shr(96, calldataload(add(offset, 40)))
                            let config := calldataload(add(offset, 60))
                            let sqrtRatioLimit := shr(160, calldataload(add(offset, 92)))
                            let skipAhead := and(shr(224, calldataload(add(offset, 104))), 0x7fffffff)
                            offset := add(offset, 108)

                            let isToken1 := resolveDirection(currentToken, token0, token1)

                            if iszero(sqrtRatioLimit) {
                                sqrtRatioLimit := minSqrtRatio
                                if xor(slt(currentAmount, 0), isToken1) {
                                    sqrtRatioLimit := maxSqrtRatio
                                }
                            }

                            let update := forwardedSwap(coreAddress, forwardee, token0, token1, config, currentAmount, isToken1, sqrtRatioLimit, skipAhead)
                            currentAmount, currentToken := nextFromUpdate(update, currentAmount, isToken1, token0, token1)
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

                            forwardWrapper(coreAddress, wrapped, forwardAmount)
                        }
                        case 3 {
                            if gt(add(offset, 108), routeEnd) {
                                revertSelector(0x84e505d2) // InvalidRoute()
                            }
                            let forwardee := shr(96, calldataload(offset))
                            let token0 := shr(96, calldataload(add(offset, 20)))
                            let token1 := shr(96, calldataload(add(offset, 40)))
                            let config := calldataload(add(offset, 60))
                            let sqrtRatioLimit := shr(160, calldataload(add(offset, 92)))
                            let skipAhead := and(shr(224, calldataload(add(offset, 104))), 0x7fffffff)
                            offset := add(offset, 108)

                            let isToken1 := resolveDirection(currentToken, token0, token1)

                            if iszero(sqrtRatioLimit) {
                                sqrtRatioLimit := minSqrtRatio
                                if xor(slt(currentAmount, 0), isToken1) {
                                    sqrtRatioLimit := maxSqrtRatio
                                }
                            }

                            let update := ve33Swap(coreAddress, forwardee, token0, token1, config, currentAmount, isToken1, sqrtRatioLimit, skipAhead)
                            currentAmount, currentToken := nextFromUpdate(update, currentAmount, isToken1, token0, token1)
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

                if threshold {
                    if exactOutKnown {
                        if xor(slt(threshold, 0), exactOut) {
                            revertSelector(0x84e505d2) // InvalidRoute()
                        }
                    }
                }

                if slt(totalCalculated, threshold) {
                    mstore(0, shl(224, 0xe65f682d)) // SlippageCheckFailed(int256)
                    mstore(4, totalCalculated)
                    revert(0, 0x24)
                }

                nativeRemaining := settle(coreAddress, specifiedToken, totalSpecified, payer, recipient, nativeRemaining)
                nativeRemaining := settle(coreAddress, calculatedToken, sub(0, totalCalculated), payer, recipient, nativeRemaining)

                if nativeRemaining {
                    if iszero(call(gas(), payer, nativeRemaining, 0, 0, 0, 0)) {
                        revertSelector(0xf4b3b1bc) // NativeTransferFailed()
                    }
                }

                mstore(0, totalCalculated)
                return(0, 0x20)
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

            function packParams(amount, isToken1, sqrtRatioLimit, skipAhead) -> params {
                params := or(
                    shl(160, sqrtRatioLimit),
                    or(
                        shl(32, and(amount, 0xffffffffffffffffffffffffffffffff)),
                        or(shl(31, isToken1), skipAhead)
                    )
                )
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

                update := mload(0x60)
            }

            function ve33Swap(coreAddress, forwardee, token0, token1, config, amount, isToken1, sqrtRatioLimit, skipAhead) -> update {
                mstore(0x20, shl(224, 0x101e8952)) // forward(address)
                mstore(0x24, forwardee)
                mstore(0x44, 0) // Ve33 swap call type
                mstore(0x64, token0)
                mstore(0x84, token1)
                mstore(0xa4, config)
                mstore(0xc4, packParams(amount, isToken1, sqrtRatioLimit, skipAhead))

                if iszero(call(gas(), coreAddress, 0, 0x20, 196, 0, 64)) {
                    returndatacopy(0x20, 0, returndatasize())
                    revert(0x20, returndatasize())
                }

                update := mload(0)
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

            function nextFromUpdate(update, amount, isToken1, token0, token1) -> nextAmount, nextToken {
                if isToken1 {
                    let delta1 := signextend(15, update)
                    if iszero(eq(delta1, amount)) {
                        revertSelector(0xe3648855) // PartialSwapsDisallowed()
                    }
                    let delta0 := sar(128, update)
                    nextAmount := sub(0, delta0)
                    nextToken := token0
                    leave
                }

                let delta0 := sar(128, update)
                if iszero(eq(delta0, amount)) {
                    revertSelector(0xe3648855) // PartialSwapsDisallowed()
                }
                let delta1 := signextend(15, update)
                nextAmount := sub(0, delta1)
                nextToken := token1
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
