cd /home/user/hp_workspace/md2doc
R=$PWD/.superpowers/sdd/2026-09-10-md2doc-v3.4.0-batch1/runs
rm -f $R/t2-red2.done
{ echo "HEAD_AT_LAUNCH=$(git rev-parse HEAD)"; echo "DIRTY=$(git status --porcelain | tr '\n' ';')"; } > $R/t2-red2.log
node test/editor-client-runtime.test.js >> $R/t2-red2.log 2>&1
echo "EXIT=$?" >> $R/t2-red2.log
touch $R/t2-red2.done
