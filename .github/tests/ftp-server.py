"""Isolated loopback FTP fixture; never connects to a user's server."""
import json
import sys
from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler
from pyftpdlib.servers import FTPServer

authorizer = DummyAuthorizer()
authorizer.add_user('skycrm-test', 'test-only', sys.argv[1], perm='elradfmwMT')
handler = FTPHandler
handler.authorizer = authorizer
server = FTPServer(('127.0.0.1', 0), handler)
print(json.dumps({'port': server.socket.getsockname()[1]}), flush=True)
server.serve_forever()
