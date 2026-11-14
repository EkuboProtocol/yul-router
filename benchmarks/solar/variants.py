import sys
def rep(s, old, new, count=1):
    assert s.count(old) == count, (old[:60], s.count(old))
    return s.replace(old, new)

def e2(s):
    # hopCount merged into the loop counter: counter = hops | (multi << 8)
    s = rep(s, '''                    let hopsRemaining := add(byte(16, header), 1)
                    // Keep the original count for partial-fill validation as the loop counts down.
                    let hopCount := hopsRemaining
''', '''                    // Bit 9 marks a multi-hop path (the count itself needs nine bits), so the counter exceeds one on every hop of such a
                    // path and equals one only on the single hop of a single-hop path.
                    let hopsRemaining := add(byte(16, header), 1)
                    hopsRemaining := or(hopsRemaining, shl(9, gt(hopsRemaining, 1)))
''')
    s = rep(s, 'for { } hopsRemaining { hopsRemaining := sub(hopsRemaining, 1) } {',
               'for { } and(hopsRemaining, 0x1ff) { hopsRemaining := sub(hopsRemaining, 1) } {')
    s = rep(s, '''                                currentToken,
                                hopCount
''', '''                                currentToken,
                                hopsRemaining
''', 2)
    return s

def e1(s):
    # tokens re-read from calldata instead of being carried through the route loop
    s = rep(s, 'let specifiedToken, calculatedToken, totalSpecified, totalCalculated := executeRoute(routeEnd)',
               'let totalSpecified, totalCalculated := executeRoute(routeEnd)\n                let specifiedToken := shr(96, calldataload(0x26))\n                let calculatedToken := shr(96, calldataload(0x3a))')
    s = rep(s, 'let specifiedToken, calculatedToken, totalSpecified, totalCalculated := executeRoute(calldatasize())',
               'let totalSpecified, totalCalculated := executeRoute(calldatasize())\n                let specifiedToken := shr(96, calldataload(0x26))\n                let calculatedToken := shr(96, calldataload(0x3a))')
    s = rep(s, 'function executeRoute(routeEnd) -> specifiedToken, calculatedToken, totalSpecified, totalCalculated {',
               'function executeRoute(routeEnd) -> totalSpecified, totalCalculated {')
    s = rep(s, '''                specifiedToken := shr(96, calldataload(0x26))
                calculatedToken := shr(96, calldataload(0x3a))

''', '')
    s = rep(s, 'let currentToken := specifiedToken', 'let currentToken := shr(96, calldataload(0x26))')
    s = rep(s, 'if iszero(eq(currentToken, calculatedToken)) {', 'if iszero(eq(currentToken, shr(96, calldataload(0x3a)))) {')
    return s


def hyb(s):
    # Variable-length buffers move to the free memory pointer; fixed-size buffers keep constant addresses.
    s = rep(s, '''                let size := calldatasize()

                mstore(0, 0xf83d08ba) // lock()
                calldatacopy(32, 0, size)
                mstore(add(size, 32), caller())
                mstore(add(size, 64), callvalue())

                if iszero(call(gas(), coreAddress, 0, 28, add(size, 0x44), 28, 0x80)) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }

                return(28, 0x80)''', '''                let size := calldatasize()
                let m := mload(0x40)
                let end := add(add(m, 32), size)

                mstore(m, 0xf83d08ba) // lock()
                calldatacopy(add(m, 32), 0, size)
                mstore(end, caller())
                mstore(add(end, 32), callvalue())

                if iszero(call(gas(), coreAddress, 0, add(m, 28), add(size, 0x44), 0, 0x80)) {
                    returndatacopy(m, 0, returndatasize())
                    revert(m, returndatasize())
                }

                return(0, 0x80)''')
    s = rep(s, '''                mstore(0, 0xf83d08ba) // lock()
                calldatacopy(32, 0x44, size)
                // The high bit cannot be present in a caller address, so it safely marks this lock as a quote.
                mstore(add(size, 32), or(caller(), shl(255, 1)))
                mstore(add(size, 64), 0)

                if call(gas(), coreAddress, 0, 28, add(size, 0x44), 0, 0) {''', '''                let m := mload(0x40)
                let end := add(add(m, 32), size)

                mstore(m, 0xf83d08ba) // lock()
                calldatacopy(add(m, 32), 0x44, size)
                // The high bit cannot be present in a caller address, so it safely marks this lock as a quote.
                mstore(end, or(caller(), shl(255, 1)))
                mstore(add(end, 32), 0)

                if call(gas(), coreAddress, 0, add(m, 28), add(size, 0x44), 0, 0) {''')
    s = rep(s, '''                        returndatacopy(0, 0x20, downstreamSize)
                        revert(0, downstreamSize)''', '''                        returndatacopy(m, 0x20, downstreamSize)
                        revert(m, downstreamSize)''')
    s = rep(s, '''                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }

            // All route and settlement helpers''', '''                returndatacopy(m, 0, returndatasize())
                revert(m, returndatasize())
            }

            // All route and settlement helpers''')
    s = rep(s, '''                let ptr := 28
                let dataPtr := add(ptr, 36)''', '''                let m := mload(0x40)
                let ptr := add(m, 28)
                let dataPtr := add(ptr, 36)''')
    s = rep(s, '''                mstore(0, 0x101e8952) // forward(address)
                mstore(add(ptr, 4), forwardee)''', '''                mstore(m, 0x101e8952) // forward(address)
                mstore(add(ptr, 4), forwardee)''')
    s = rep(s, '''                if iszero(call(gas(), caller(), 0, ptr, add(0x124, paddedSignatureLength), ptr, 64)) {
                    revertExternalCall(0)
                }
                if lt(returndatasize(), 32) {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }

                update := mload(ptr)''', '''                if iszero(call(gas(), caller(), 0, ptr, add(0x124, paddedSignatureLength), 0, 64)) {
                    revertExternalCall()
                }
                if lt(returndatasize(), 32) {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }

                update := mload(0)''')
    s = rep(s, 'revertExternalCall(0)', 'revertExternalCall()', 3)
    s = rep(s, '''            function revertExternalCall(ptr) {
                let size := returndatasize()''', '''            function revertExternalCall() {
                let size := returndatasize()
                let ptr := mload(0x40)''')
    s = rep(s, '''                    if returndatasize() {
                        returndatacopy(0, 0, returndatasize())
                        revert(0, returndatasize())
                    }''', '''                    if returndatasize() {
                        let m := mload(0x40)
                        returndatacopy(m, 0, returndatasize())
                        revert(m, returndatasize())
                    }''')
    s = rep(s, '''                if iszero(call(gas(), caller(), 0, 8, 60, 0, 0)) {
                    returndatacopy(0, 0, returndatasize())
                    revert(0, returndatasize())
                }''', '''                if iszero(call(gas(), caller(), 0, 8, 60, 0, 0)) {
                    let m := mload(0x40)
                    returndatacopy(m, 0, returndatasize())
                    revert(m, returndatasize())
                }''')
    return s


def l80(s):
    # Fixed-size ABI buffers move from 0x00 to 0x80 so the free memory pointer word stays intact.
    s = hyb(s)
    s = rep(s, '''                if iszero(call(gas(), coreAddress, 0, add(m, 28), add(size, 0x44), 0, 0x80)) {
                    returndatacopy(m, 0, returndatasize())
                    revert(m, returndatasize())
                }

                return(0, 0x80)''', '''                if iszero(call(gas(), coreAddress, 0, add(m, 28), add(size, 0x44), m, 0x80)) {
                    returndatacopy(m, 0, returndatasize())
                    revert(m, returndatasize())
                }

                return(m, 0x80)''')
    s = rep(s, '''                        returndatacopy(0, 4, 0x80)
                        return(0, 0x80)''', '''                        returndatacopy(m, 4, 0x80)
                        return(m, 0x80)''')
    s = rep(s, '''                    mstore(0, 0x4852c8eb) // QuoteResult(address,address,int256,int256)
                    mstore(32, specifiedToken)
                    mstore(64, calculatedToken)
                    mstore(96, totalSpecified)
                    mstore(128, totalCalculated)
                    revert(28, 0x84)''', '''                    mstore(0x80, 0x4852c8eb) // QuoteResult(address,address,int256,int256)
                    mstore(0xa0, specifiedToken)
                    mstore(0xc0, calculatedToken)
                    mstore(0xe0, totalSpecified)
                    mstore(0x100, totalCalculated)
                    revert(0x9c, 0x84)''')
    s = rep(s, '''                mstore(0, specifiedToken)
                mstore(0x20, calculatedToken)
                mstore(0x40, totalSpecified)
                mstore(0x60, totalCalculated)
                return(0, 0x80)''', '''                mstore(0x80, specifiedToken)
                mstore(0xa0, calculatedToken)
                mstore(0xc0, totalSpecified)
                mstore(0xe0, totalCalculated)
                return(0x80, 0x80)''', 2)
    s = rep(s, '''                mstore(0, 0) // swap_6269342730()
                mstore(4, token0)
                mstore(0x24, token1)
                mstore(0x44, config)
                mstore(0x64, packParams(amount, isToken1, sqrtRatioLimit, skipAhead))

                if iszero(call(gas(), caller(), 0, 0, 132, 0, 64)) {''', '''                mstore(0x80, 0) // swap_6269342730()
                mstore(0x84, token0)
                mstore(0xa4, token1)
                mstore(0xc4, config)
                mstore(0xe4, packParams(amount, isToken1, sqrtRatioLimit, skipAhead))

                if iszero(call(gas(), caller(), 0, 0x80, 132, 0, 64)) {''')
    s = rep(s, '''                mstore(0, 0x101e8952) // forward(address)
                mstore(32, forwardee)
                mstore(64, token0)
                mstore(96, token1)
                mstore(128, config)
                mstore(160, packParams(amount, isToken1, sqrtRatioLimit, skipAhead))

                if iszero(call(gas(), caller(), 0, 28, 164, 28, 64)) {
                    revertExternalCall()
                }
                if lt(returndatasize(), 32) {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }

                update := mload(28)''', '''                mstore(0x80, 0x101e8952) // forward(address)
                mstore(0xa0, forwardee)
                mstore(0xc0, token0)
                mstore(0xe0, token1)
                mstore(0x100, config)
                mstore(0x120, packParams(amount, isToken1, sqrtRatioLimit, skipAhead))

                if iszero(call(gas(), caller(), 0, 0x9c, 164, 0, 64)) {
                    revertExternalCall()
                }
                if lt(returndatasize(), 32) {
                    revertSelector(0x84e505d2) // InvalidRoute()
                }

                update := mload(0)''')
    s = rep(s, '''                mstore(0, 0x101e8952) // forward(address)
                mstore(32, wrapper)
                mstore(64, amount)

                if iszero(call(gas(), caller(), 0, 28, 68, 0, 0)) {''', '''                mstore(0x80, 0x101e8952) // forward(address)
                mstore(0xa0, wrapper)
                mstore(0xc0, amount)

                if iszero(call(gas(), caller(), 0, 0x9c, 68, 0, 0)) {''')
    s = rep(s, '''                // The ABI buffer starts at byte 28 so selectors need no shift. Return
                // data overlays that same buffer, preserving short-return semantics.''', '''                // Each ABI buffer starts 28 bytes into its first word so selectors need no shift.
                // The two payment brackets fit scratch space. Return data overlays the
                // transferFrom buffer, preserving short-return semantics.''')
    s = rep(s, '''                mstore(0, 0x23b872dd) // transferFrom(address,address,uint256)
                mstore(32, payer)
                mstore(64, caller())
                mstore(96, amount)

                let success := call(gas(), token, 0, 28, 100, 28, 32)
                if iszero(and(success, or(iszero(returndatasize()), eq(mload(28), 1)))) {''', '''                mstore(0x80, 0x23b872dd) // transferFrom(address,address,uint256)
                mstore(0xa0, payer)
                mstore(0xc0, caller())
                mstore(0xe0, amount)

                let success := call(gas(), token, 0, 0x9c, 100, 0x9c, 32)
                if iszero(and(success, or(iszero(returndatasize()), eq(mload(0x9c), 1)))) {''')
    s = rep(s, '''                // Bytes 8..67 hold selector (4), token (20), recipient (20), amount (16).
                mstore(36, amount)
                mstore(20, recipient)
                mstore(0, or(shl(160, 0x3ccfd60b), token))

                if iszero(call(gas(), caller(), 0, 8, 60, 0, 0)) {''', '''                // Bytes 0x88..0xc3 hold selector (4), token (20), recipient (20), amount (16).
                mstore(0xa4, amount)
                mstore(0x94, recipient)
                mstore(0x80, or(shl(160, 0x3ccfd60b), token))

                if iszero(call(gas(), caller(), 0, 0x88, 60, 0, 0)) {''')
    s = rep(s, '''/// terminates every path itself, so no Solidity dispatcher, ABI coder or memory allocator is used.''', '''/// terminates every path itself, so no Solidity dispatcher, ABI coder or memory allocator is used.
/// @dev Memory layout. Scratch space (0x00..0x3f) holds selector reverts, call results and the two
/// payment brackets. Fixed-size ABI buffers live at constant addresses from 0x80. Variable-length
/// buffers (the lock envelope, a signed swap's signature and bubbled revert data) start at the free
/// memory pointer, which is never moved and never overwritten. A compiler that reserves memory for
/// its own use places it clear of the constant ranges and below the free memory pointer, so no
/// buffer of any length can overlap it.''')
    return s

src = open(sys.argv[1]).read()
for name in sys.argv[3].split('+'):
    if name: src = globals()[name](src)
open(sys.argv[2], 'w').write(src)
