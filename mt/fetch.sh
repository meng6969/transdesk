set -u
B=https://hf-mirror.com/midudev/firefox-translations/resolve/main
dl(){ curl -sSL --retry 3 -m 900 -o "$2" "$B/$1" && echo "OK  $2 $(stat -c%s "$2")" || echo "FAIL $1"; }
dl zh-en/model.zhen.intgemm.alphas.bin zh-en/model.zhen.intgemm.alphas.bin
dl zh-en/lex.50.50.zhen.s2t.bin        zh-en/lex.50.50.zhen.s2t.bin
dl zh-en/vocab.zhen.spm                zh-en/vocab.zhen.spm
dl en-zh/model.enzh.intgemm.alphas.bin en-zh/model.enzh.intgemm.alphas.bin
dl en-zh/lex.50.50.enzh.s2t.bin        en-zh/lex.50.50.enzh.s2t.bin
dl en-zh/srcvocab.enzh.spm             en-zh/srcvocab.enzh.spm
dl en-zh/trgvocab.enzh.spm             en-zh/trgvocab.enzh.spm
echo ALLDONE
