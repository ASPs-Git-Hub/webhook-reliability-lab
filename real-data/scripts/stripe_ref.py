"""Second, independent implementation of the documented Stripe signing recipe. Prints the hex HMAC.
Usage: python3 -I stripe_ref.py <secret> <timestamp> <payload-file>"""
import hashlib, hmac, sys
secret, ts, path = sys.argv[1], sys.argv[2], sys.argv[3]
payload = open(path, 'rb').read()
print(hmac.new(secret.encode(), ts.encode() + b'.' + payload, hashlib.sha256).hexdigest())
