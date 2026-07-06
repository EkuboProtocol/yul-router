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
                let ptr := 0

                mstore(ptr, shl(224, 0xf83d08ba)) // lock()
                calldatacopy(add(ptr, 4), 0, size)
                let tail := add(ptr, size)
                mstore(add(tail, 4), caller())
                mstore(add(tail, 0x24), callvalue())

                if iszero(call(gas(), coreAddress, 0, ptr, add(size, 0x44), ptr, 0x20)) {
                    returndatacopy(ptr, 0, returndatasize())
                    revert(ptr, returndatasize())
                }

                return(ptr, 0x20)
            }

            function locked(coreAddress) {
                let minSqrtRatio := 0x00000000400065a8177fae27
                let maxSqrtRatio := 0xffff9a5889f795069a41a8a3

                let routeEnd := sub(calldatasize(), 0x40)
                let payer := calldataload(routeEnd)
                let nativeRemaining := calldataload(add(routeEnd, 0x20))

                let offset := 0x24

                if gt(0x5e, routeEnd) {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }

                let flagsWord := calldataload(0x24)
                let flags := byte(0, flagsWord)
                let multiHopsRemaining := add(byte(1, flagsWord), 1)

                let specifiedToken := shr(96, calldataload(0x26))
                let calculatedToken := shr(96, calldataload(0x3a))
                let threshold := signextend(15, shr(128, calldataload(0x4e)))
                offset := 0x5e

                let recipient := payer
                if and(flags, 1) {
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
                    if gt(add(offset, 17), routeEnd) {
                        revertSelector(0x84e505d2) // InvalidRoute()
                    }

                    let currentToken := specifiedToken
                    let currentAmount := signextend(15, shr(128, calldataload(offset)))
                    offset := add(offset, 16)

                    totalSpecified := add(totalSpecified, currentAmount)

                    if currentAmount {
                        let routeExactOut := slt(currentAmount, 0)
                        if exactOutKnown {
                            if xor(exactOut, routeExactOut) {
                                revertSelector(0x84e505d2) // InvalidRoute()
                            }
                        }
                        exactOutKnown := 1
                        exactOut := routeExactOut
                    }

                    let hopsRemaining := add(byte(0, calldataload(offset)), 1)
                    offset := add(offset, 1)

                    for { } hopsRemaining { hopsRemaining := sub(hopsRemaining, 1) } {
                        let hopType := byte(0, calldataload(offset))
                        offset := add(offset, 1)

                        switch hopType
                        case 0 {
                            if gt(add(offset, 88), routeEnd) {
                                revertSelector(0x84e505d2) // InvalidRoute()
                            }
                            let token0 := shr(96, calldataload(offset))
                            let token1 := shr(96, calldataload(add(offset, 20)))
                            let config := calldataload(add(offset, 40))
                            let sqrtRatioLimit := shr(160, calldataload(add(offset, 72)))
                            let skipAhead := and(shr(224, calldataload(add(offset, 84))), 0x7fffffff)
                            offset := add(offset, 88)

                            let isToken1 := resolveDirection(currentToken, token0, token1)
                            let isExactOut := slt(currentAmount, 0)

                            if iszero(sqrtRatioLimit) {
                                sqrtRatioLimit := minSqrtRatio
                                if xor(isExactOut, isToken1) {
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
                            let isExactOut := slt(currentAmount, 0)

                            if iszero(sqrtRatioLimit) {
                                sqrtRatioLimit := minSqrtRatio
                                if xor(isExactOut, isToken1) {
                                    sqrtRatioLimit := maxSqrtRatio
                                }
                            }

                            let update := forwardedSwap(coreAddress, forwardee, token0, token1, config, currentAmount, isToken1, sqrtRatioLimit, skipAhead)
                            currentAmount, currentToken := nextFromUpdate(update, currentAmount, isToken1, token0, token1)
                        }
                        case 2 {
                            if gt(add(offset, 40), routeEnd) {
                                revertSelector(0x84e505d2) // InvalidRoute()
                            }
                            let underlying := shr(96, calldataload(offset))
                            let wrapped := shr(96, calldataload(add(offset, 20)))
                            offset := add(offset, 40)

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
                            let isExactOut := slt(currentAmount, 0)

                            if iszero(sqrtRatioLimit) {
                                sqrtRatioLimit := minSqrtRatio
                                if xor(isExactOut, isToken1) {
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

                if and(threshold, exactOutKnown) {
                    if xor(slt(threshold, 0), exactOut) {
                        revertSelector(0x84e505d2) // InvalidRoute()
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
                isToken1 := eq(currentToken, token1)
                if iszero(or(eq(currentToken, token0), isToken1)) {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }
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
                let ptr := 0x80

                mstore(ptr, 0) // swap_6269342730()
                mstore(add(ptr, 4), token0)
                mstore(add(ptr, 36), token1)
                mstore(add(ptr, 68), config)
                mstore(add(ptr, 100), packParams(amount, isToken1, sqrtRatioLimit, skipAhead))

                if iszero(call(gas(), coreAddress, 0, ptr, 132, ptr, 64)) {
                    returndatacopy(ptr, 0, returndatasize())
                    revert(ptr, returndatasize())
                }

                update := mload(ptr)
            }

            function forwardedSwap(coreAddress, forwardee, token0, token1, config, amount, isToken1, sqrtRatioLimit, skipAhead) -> update {
                let ptr := 0x80

                mstore(ptr, shl(224, 0x101e8952)) // forward(address)
                mstore(add(ptr, 4), forwardee)
                mstore(add(ptr, 36), token0)
                mstore(add(ptr, 68), token1)
                mstore(add(ptr, 100), config)
                mstore(add(ptr, 132), packParams(amount, isToken1, sqrtRatioLimit, skipAhead))

                if iszero(call(gas(), coreAddress, 0, ptr, 164, ptr, 64)) {
                    returndatacopy(ptr, 0, returndatasize())
                    revert(ptr, returndatasize())
                }

                update := mload(ptr)
            }

            function ve33Swap(coreAddress, forwardee, token0, token1, config, amount, isToken1, sqrtRatioLimit, skipAhead) -> update {
                let ptr := 0x40

                mstore(ptr, shl(224, 0x101e8952)) // forward(address)
                mstore(add(ptr, 4), forwardee)
                mstore(add(ptr, 36), 0) // Ve33 swap call type
                mstore(add(ptr, 68), token0)
                mstore(add(ptr, 100), token1)
                mstore(add(ptr, 132), config)
                mstore(add(ptr, 164), packParams(amount, isToken1, sqrtRatioLimit, skipAhead))

                if iszero(call(gas(), coreAddress, 0, ptr, 196, 0, 64)) {
                    returndatacopy(ptr, 0, returndatasize())
                    revert(ptr, returndatasize())
                }

                update := mload(0)
            }

            function forwardWrapper(coreAddress, wrapper, amount) {
                let ptr := 0

                mstore(ptr, shl(224, 0x101e8952)) // forward(address)
                mstore(add(ptr, 4), wrapper)
                mstore(add(ptr, 36), amount)

                if iszero(call(gas(), coreAddress, 0, ptr, 68, 0, 0)) {
                    returndatacopy(ptr, 0, returndatasize())
                    revert(ptr, returndatasize())
                }
            }

            function nextFromUpdate(update, amount, isToken1, token0, token1) -> nextAmount, nextToken {
                let delta0 := signextend(15, shr(128, update))
                let delta1 := signextend(15, update)

                switch isToken1
                case 0 {
                    if iszero(eq(delta0, amount)) {
                        revertSelector(0xe3648855) // PartialSwapsDisallowed()
                    }
                    nextAmount := sub(0, delta1)
                    nextToken := token1
                }
                default {
                    if iszero(eq(delta1, amount)) {
                        revertSelector(0xe3648855) // PartialSwapsDisallowed()
                    }
                    nextAmount := sub(0, delta0)
                    nextToken := token0
                }
            }

            function settle(coreAddress, token, signedAmount, payer, recipient, nativeRemaining) -> updatedNativeRemaining {
                updatedNativeRemaining := nativeRemaining

                switch sgt(signedAmount, 0)
                case 1 {
                    updatedNativeRemaining := pay(coreAddress, token, payer, signedAmount, nativeRemaining)
                }
                default {
                    if slt(signedAmount, 0) {
                        withdraw(coreAddress, token, recipient, sub(0, signedAmount))
                    }
                }
            }

            function pay(coreAddress, token, payer, amount, nativeRemaining) -> updatedNativeRemaining {
                updatedNativeRemaining := nativeRemaining

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
                }
            }

            function payErc20(coreAddress, payer, token, amount) {
                // startPayments(token)
                mstore(0, shl(224, 0xf9b6a796))
                mstore(4, token)
                pop(call(gas(), coreAddress, 0, 0, 36, 0, 0))

                let ptr := 0x20
                mstore(ptr, shl(224, 0x23b872dd)) // transferFrom(address,address,uint256)
                mstore(add(ptr, 4), payer)
                mstore(add(ptr, 36), coreAddress)
                mstore(add(ptr, 68), amount)

                let success := call(gas(), token, 0, ptr, 100, 0, 32)
                if iszero(and(success, or(iszero(returndatasize()), eq(mload(0), 1)))) {
                    if returndatasize() {
                        returndatacopy(ptr, 0, returndatasize())
                        revert(ptr, returndatasize())
                    }
                    revertSelector(0x7939f424) // TransferFromFailed()
                }

                // completePayments(token)
                mstore(0, shl(224, 0x12e103f1))
                mstore(4, token)
                pop(call(gas(), coreAddress, 0, 0, 36, 0, 0))
            }

            function withdraw(coreAddress, token, recipient, amount) {
                let ptr := 0

                mstore(ptr, shl(224, 0x3ccfd60b)) // withdraw()
                mstore(add(ptr, 4), shl(96, token))
                mstore(add(ptr, 24), shl(96, recipient))
                mstore(add(ptr, 44), shl(128, amount))

                if iszero(call(gas(), coreAddress, 0, ptr, 60, 0, 0)) {
                    returndatacopy(ptr, 0, returndatasize())
                    revert(ptr, returndatasize())
                }
            }

            function revertSelector(selector) {
                mstore(0, shl(224, selector))
                revert(0, 4)
            }
        }
    }
}
