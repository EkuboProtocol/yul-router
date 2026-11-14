import re,sys
log=open(sys.argv[1]).read()
d={}
for m in re.finditer(r'payload-(\d)-(\d+): (0x[0-9a-f]+)',log):
    d[(int(m[1]),int(m[2]))]=bytes.fromhex(m[3][2:])
n=max(k[1] for k in d)+1
for i in range(n):
    x=d[(0,i)]; y=d[(1,i)]
    x=x[64:64+int.from_bytes(x[32:64],'big')]; y=y[64:64+int.from_bytes(y[32:64],'big')]
    diffs=[j for j in range(min(len(x),len(y))) if x[j]!=y[j]]
    print(i,'len',len(x),len(y),'ndiff',len(diffs))
    if diffs:
        lo=diffs[0]; hi=diffs[-1]
        print('  baseline ',x[lo:lo+40].hex()); print('  candidate',y[lo:lo+40].hex())
        print('  router memory address of first diff', hex(lo-36+64), 'last', hex(hi-36+64), '(signature starts at 0x140)')
