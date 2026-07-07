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

                if iszero(call(gas(), coreAddress, 0, 0, add(size, 0x44), 0, 0)) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }

                return(0, 0)
            }

            function locked(coreAddress) {
                let minSqrtRatio := 0x00000000400065a8177fae27
                let maxSqrtRatio := 0xffff9a5889f795069a41a8a3

                mstore(0x240, sub(calldatasize(), 0x40))
                let payer := calldataload(mload(0x240))
                let nativeRemaining := calldataload(add(mload(0x240), 0x20))

                let offset := 0x28
                let threshold := 0
                let specifiedToken := 0
                let calculatedToken := 0
                let recipient := payer
                let multiHopsRemaining := 0
                let specifiedAmountBytes := 0

                {
                    let flagsWord := calldataload(0x24)
                    let flags := byte(0, flagsWord)
                    let exactOut := and(shr(1, flags), 1)
                    mstore(0x200, exactOut)
                    mstore(0x220, and(flags, 4))

                    multiHopsRemaining := add(byte(1, flagsWord), 1)
                    specifiedAmountBytes := byte(2, flagsWord)
                    let thresholdBytes := byte(3, flagsWord)

                    if or(gt(specifiedAmountBytes, 16), gt(thresholdBytes, 16)) {
                        revertSelector(0x84e505d2) // InvalidRoute()
                    }

                    switch thresholdBytes
                    case 0 {
                        if exactOut {
                            threshold := sub(0, shl(127, 1))
                        }
                    }
                    default {
                        if gt(add(offset, thresholdBytes), mload(0x240)) {
                            revertSelector(0x84e505d2) // InvalidRoute()
                        }
                        threshold := shr(sub(256, mul(thresholdBytes, 8)), calldataload(offset))
                        if exactOut {
                            threshold := sub(0, threshold)
                        }
                        offset := add(offset, thresholdBytes)
                    }

                    if iszero(and(flags, 8)) {
                        if gt(add(offset, 20), mload(0x240)) {
                            revertSelector(0x84e505d2) // InvalidRoute()
                        }
                        specifiedToken := shr(96, calldataload(offset))
                        offset := add(offset, 20)
                    }

                    if iszero(and(flags, 16)) {
                        if gt(add(offset, 20), mload(0x240)) {
                            revertSelector(0x84e505d2) // InvalidRoute()
                        }
                        calculatedToken := shr(96, calldataload(offset))
                        offset := add(offset, 20)
                    }

                    if and(flags, 1) {
                        if gt(add(offset, 20), mload(0x240)) {
                            revertSelector(0x84e505d2) // InvalidRoute()
                        }
                        recipient := shr(96, calldataload(offset))
                        offset := add(offset, 20)
                    }
                }

                let totalSpecified := 0
                let totalCalculated := 0

                for { } multiHopsRemaining { multiHopsRemaining := sub(multiHopsRemaining, 1) } {
                    let currentToken := specifiedToken
                    let currentAmount := 0
                    switch specifiedAmountBytes
                    case 0 { }
                    default {
                        if gt(add(offset, specifiedAmountBytes), mload(0x240)) {
                            revertSelector(0x84e505d2) // InvalidRoute()
                        }
                        currentAmount := shr(sub(256, mul(specifiedAmountBytes, 8)), calldataload(offset))
                        if mload(0x200) {
                            currentAmount := sub(0, currentAmount)
                        }
                        offset := add(offset, specifiedAmountBytes)
                    }
                    let hopsRemaining := add(byte(0, calldataload(offset)), 1)
                    offset := add(offset, 1)

                    if gt(offset, mload(0x240)) {
                        revertSelector(0x84e505d2) // InvalidRoute()
                    }

                    totalSpecified := add(totalSpecified, currentAmount)

                    for { } hopsRemaining { hopsRemaining := sub(hopsRemaining, 1) } {
                        let hopType := byte(0, calldataload(offset))
                        offset := add(offset, 1)
                        let isLastHop := eq(hopsRemaining, 1)

                        switch hopType
                        case 0 {
                            let skipAhead := byte(0, calldataload(offset))
                            let config := shr(160, calldataload(add(offset, 1)))
                            offset := add(offset, 13)
                            if gt(offset, mload(0x240)) {
                                revertSelector(0x84e505d2) // InvalidRoute()
                            }

                            let sqrtRatioLimit := 0
                            if mload(0x220) {
                                sqrtRatioLimit := readSqrtRatioLimit(offset)
                                offset := add(offset, 12)
                            }

                            let nextToken := calculatedToken
                            if iszero(isLastHop) {
                                nextToken, offset := readToken(offset)
                            }

                            let token0, token1, isToken1 := orderTokens(currentToken, nextToken)

                            if iszero(sqrtRatioLimit) {
                                sqrtRatioLimit := minSqrtRatio
                                if xor(mload(0x200), isToken1) {
                                    sqrtRatioLimit := maxSqrtRatio
                                }
                            }

                            let update := coreSwap(coreAddress, token0, token1, config, currentAmount, isToken1, sqrtRatioLimit, skipAhead)
                            currentAmount, currentToken := nextFromUpdate(update, currentAmount, isToken1, token0, token1)
                        }
                        case 1 {
                            let skipAhead := byte(0, calldataload(offset))
                            let config := calldataload(add(offset, 1))
                            offset := add(offset, 33)
                            if gt(offset, mload(0x240)) {
                                revertSelector(0x84e505d2) // InvalidRoute()
                            }

                            let sqrtRatioLimit := 0
                            if mload(0x220) {
                                sqrtRatioLimit := readSqrtRatioLimit(offset)
                                offset := add(offset, 12)
                            }

                            let nextToken := calculatedToken
                            if iszero(isLastHop) {
                                nextToken, offset := readToken(offset)
                            }

                            let token0, token1, isToken1 := orderTokens(currentToken, nextToken)

                            if iszero(sqrtRatioLimit) {
                                sqrtRatioLimit := minSqrtRatio
                                if xor(mload(0x200), isToken1) {
                                    sqrtRatioLimit := maxSqrtRatio
                                }
                            }

                            let update := coreSwap(coreAddress, token0, token1, config, currentAmount, isToken1, sqrtRatioLimit, skipAhead)
                            currentAmount, currentToken := nextFromUpdate(update, currentAmount, isToken1, token0, token1)
                        }
                        case 2 {
                            if gt(add(offset, 53), mload(0x240)) {
                                revertSelector(0x84e505d2) // InvalidRoute()
                            }
                            let skipAhead := byte(0, calldataload(offset))
                            let forwardee := shr(96, calldataload(add(offset, 1)))
                            let config := calldataload(add(offset, 21))
                            offset := add(offset, 53)

                            let sqrtRatioLimit := 0
                            if mload(0x220) {
                                sqrtRatioLimit := readSqrtRatioLimit(offset)
                                offset := add(offset, 12)
                            }

                            let nextToken := calculatedToken
                            if iszero(isLastHop) {
                                nextToken, offset := readToken(offset)
                            }

                            let token0, token1, isToken1 := orderTokens(currentToken, nextToken)

                            if iszero(sqrtRatioLimit) {
                                sqrtRatioLimit := minSqrtRatio
                                if xor(mload(0x200), isToken1) {
                                    sqrtRatioLimit := maxSqrtRatio
                                }
                            }

                            let update := forwardedSwap(coreAddress, forwardee, token0, token1, config, currentAmount, isToken1, sqrtRatioLimit, skipAhead)
                            currentAmount, currentToken := nextFromUpdate(update, currentAmount, isToken1, token0, token1)
                        }
                        case 3 {
                            let unwrap := byte(0, calldataload(offset))
                            offset := add(offset, 1)
                            if gt(offset, mload(0x240)) {
                                revertSelector(0x84e505d2) // InvalidRoute()
                            }

                            if gt(unwrap, 1) {
                                revertSelector(0x84e505d2) // InvalidRoute()
                            }

                            let nextToken := calculatedToken
                            if iszero(isLastHop) {
                                nextToken, offset := readToken(offset)
                            }

                            let forwardAmount := currentAmount
                            let wrapper := nextToken
                            if eq(currentToken, nextToken) {
                                revertSelector(0x84e505d2) // InvalidRoute()
                            }

                            if unwrap {
                                forwardAmount := sub(0, currentAmount)
                                wrapper := currentToken
                            }

                            forwardWrapper(coreAddress, wrapper, forwardAmount)
                            currentToken := nextToken
                        }
                        case 4 {
                            if gt(add(offset, 25), mload(0x240)) {
                                revertSelector(0x84e505d2) // InvalidRoute()
                            }
                            let skipAhead := byte(0, calldataload(offset))
                            let forwardee := shr(96, calldataload(add(offset, 1)))
                            let poolTypeConfig := shr(224, calldataload(add(offset, 21)))
                            let config := or(shl(96, forwardee), poolTypeConfig)
                            offset := add(offset, 25)

                            let sqrtRatioLimit := 0
                            if mload(0x220) {
                                sqrtRatioLimit := readSqrtRatioLimit(offset)
                                offset := add(offset, 12)
                            }

                            let nextToken := calculatedToken
                            if iszero(isLastHop) {
                                nextToken, offset := readToken(offset)
                            }

                            let token0, token1, isToken1 := orderTokens(currentToken, nextToken)

                            if iszero(sqrtRatioLimit) {
                                sqrtRatioLimit := minSqrtRatio
                                if xor(mload(0x200), isToken1) {
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

                if iszero(eq(offset, mload(0x240))) {
                    revertSelector(0x84e505d2) // InvalidRoute()
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

                return(0, 0)
            }

            function readSqrtRatioLimit(offset) -> sqrtRatioLimit {
                if gt(add(offset, 12), mload(0x240)) {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }
                sqrtRatioLimit := shr(160, calldataload(offset))
            }

            function readToken(offset) -> token, nextOffset {
                if gt(add(offset, 1), mload(0x240)) {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }
                let tokenInfo := byte(0, calldataload(offset))
                nextOffset := add(offset, 1)
                switch tokenInfo
                case 0 {
                    token := 0
                }
                case 1 {
                    if gt(add(nextOffset, 20), mload(0x240)) {
                        revertSelector(0x84e505d2) // InvalidRoute()
                    }
                    token := shr(96, calldataload(nextOffset))
                    nextOffset := add(nextOffset, 20)
                }
                default {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }
            }

            function orderTokens(currentToken, nextToken) -> token0, token1, isToken1 {
                if lt(currentToken, nextToken) {
                    token0 := currentToken
                    token1 := nextToken
                    leave
                }
                if gt(currentToken, nextToken) {
                    token0 := nextToken
                    token1 := currentToken
                    isToken1 := 1
                    leave
                }
                revertSelector(0x84e505d2) // InvalidRoute()
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

                pop(call(gas(), token, 0, 0, 100, 0, 0))

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
