#!/bin/sh
# Issues Keelson's document-signing chain for Alibi PDFs into <dir>: a P-256 root and a leaf for
# document signing (id-kp-documentSigning, RFC 9336). signing-key.pem and signing-chain.pem (leaf
# first) are KEELSON_PDF_SIGNING_KEY and KEELSON_PDF_SIGNING_CHAIN; root.pem is the trust anchor
# a reader adds to verify the signature.
set -eu
dir=${1:?usage: pdf-cert.sh <dir>}
mkdir -p "$dir"
cd "$dir"
umask 077
openssl ecparam -name prime256v1 -genkey -noout -out root-key.pem
openssl req -x509 -new -key root-key.pem -sha256 -days 3650 -out root.pem \
  -subj "/O=Keelson/CN=Keelson Document Signing Root" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"
openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -out signing-key.pem
openssl req -new -key signing-key.pem -out leaf.csr -subj "/O=Keelson/CN=Keelson Alibi"
printf '%s\n' "basicConstraints=critical,CA:FALSE" "keyUsage=critical,digitalSignature,nonRepudiation" \
  "extendedKeyUsage=1.3.6.1.5.5.7.3.36" > leaf.ext
openssl x509 -req -in leaf.csr -CA root.pem -CAkey root-key.pem -CAcreateserial -sha256 \
  -days 825 -extfile leaf.ext -out leaf.pem
cat leaf.pem root.pem > signing-chain.pem
rm -f leaf.csr leaf.ext root.srl
