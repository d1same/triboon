#!/bin/sh
# Runs INSIDE ubuntu:20.04 (rar 5.50 — supports both -ma4 and -ma5; see README.md). Two jobs:
#  1. VALIDATE the hand-rolled JS store archives with real unrar/unzip — ground truth.
#  2. GENERATE real-tool fixtures: store/compressed/password RARs and 7z archives.
# NOTE: unrar exits 0 on checksum WARNINGS, so we grep its output instead of trusting $?.
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq rar unrar p7zip-full unzip >/dev/null 2>&1

cd /fix/work
echo '== 1. validating JS-built archives with real tools =='
for f in js4single.rar js4multi.rar js5single.rar js5multi.part1.rar; do
  out=$(unrar t "$f" 2>&1)
  if echo "$out" | grep -qiE 'error|warning|corrupt'; then
    echo "FAIL unrar t $f:"; echo "$out"; exit 1
  fi
  echo "OK unrar t $f"
done
mkdir -p /tmp/x4 /tmp/x5 /tmp/xz
unrar x -idq js4multi.rar /tmp/x4/ && cmp /tmp/x4/inner.mkv inner.mkv && echo 'OK js4multi bytes'
unrar x -idq js5multi.part1.rar /tmp/x5/ && cmp /tmp/x5/inner.mkv inner.mkv && echo 'OK js5multi bytes'
unzip -qq -t jszip.zip && echo 'OK unzip t jszip.zip'
unzip -qq jszip.zip -d /tmp/xz && cmp /tmp/xz/inner.mkv inner.mkv && echo 'OK jszip bytes'

echo '== 2. generating real-tool fixtures =='
rm -rf /fix/real && mkdir -p /fix/real && cd /fix/real
cp ../work/inner.mkv .
rar a -ma4 -m0 -idq real4store.rar inner.mkv
rar a -ma5 -m0 -idq real5store.rar inner.mkv
rar a -ma5 -m0 -v100k -idq real5multi.rar inner.mkv
rar a -ma4 -m3 -idq comp4.rar inner.mkv
rar a -ma5 -m3 -idq comp5.rar inner.mkv
rar a -ma5 -m0 -pSecret123 -idq pass5.rar inner.mkv
rar a -ma5 -m0 -hpSecret123 -idq passhdr5.rar inner.mkv
7z a -bso0 -mx0 store7z.7z inner.mkv
7z a -bso0 -mx5 lzma7z.7z inner.mkv
rm inner.mkv
ls -la /fix/real
echo 'ALL DONE'
