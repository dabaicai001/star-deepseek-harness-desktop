"""Minimal paramiko SFTP server for local testing.
Listens on 127.0.0.1:2222, accepts any key, user: testuser / testpass.
"""
import os
import threading
import traceback
import socket
import paramiko
from paramiko import RSAKey
from paramiko.sftp_server import SFTPServer, SFTPServerInterface
from paramiko.sftp_handle import SFTPHandle


HOST = "127.0.0.1"
PORT = 2222
ROOT = os.path.abspath("./sftp_root")


class StubServer(paramiko.ServerInterface):
    def check_auth_password(self, username, password):
        if username == "testuser" and password == "testpass":
            return paramiko.AUTH_SUCCESSFUL
        return paramiko.AUTH_FAILED

    def get_allowed_auths(self, username):
        return "password"

    def check_channel_request(self, kind, chanid):
        if kind == "session":
            return paramiko.OPEN_SUCCEEDED
        return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED


class StubSFTPInterface(SFTPServerInterface):
    def __init__(self, server, *args, **kwargs):
        super().__init__(server, *args, **kwargs)
        self.root = ROOT

    def _resolve(self, path):
        if not path.startswith("/"):
            path = "/" + path
        return os.path.normpath(os.path.join(self.root, path.lstrip("/")))

    def list_folder(self, path):
        real = self._resolve(path)
        try:
            entries = os.listdir(real)
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)
        out = []
        for name in entries:
            full = os.path.join(real, name)
            try:
                st = os.stat(full)
            except OSError:
                continue
            attr = paramiko.SFTPAttributes.from_stat(st, name)
            out.append(attr)
        return out

    def stat(self, path):
        real = self._resolve(path)
        try:
            st = os.stat(real)
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)
        return paramiko.SFTPAttributes.from_stat(st, os.path.basename(real))

    def lstat(self, path):
        return self.stat(path)

    def open(self, path, flags, attr):
        real = self._resolve(path)
        try:
            mode_flags = 0
            if flags & paramiko.SFTP_FLAG_WRITE:
                mode_flags |= os.O_WRONLY
            else:
                mode_flags |= os.O_RDONLY
            if flags & paramiko.SFTP_FLAG_CREATE:
                mode_flags |= os.O_CREAT
            if flags & paramiko.SFTP_FLAG_TRUNC:
                mode_flags |= os.O_TRUNC
            if flags & paramiko.SFTP_FLAG_APPEND:
                mode_flags |= os.O_APPEND
            if flags & paramiko.SFTP_FLAG_EXCL:
                mode_flags |= os.O_EXCL
            fd = os.open(real, mode_flags, 0o644)
            handle = SFTPHandle(flags)
            handle.filename = real
            if mode_flags & os.O_WRONLY:
                handle.writefile = os.fdopen(fd, "wb", -1)
                handle.readfile = handle.writefile
            else:
                handle.readfile = os.fdopen(fd, "rb", -1)
            return handle
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)

    def remove(self, path):
        real = self._resolve(path)
        try:
            os.remove(real)
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)
        return paramiko.SFTP_OK

    def mkdir(self, path, attr):
        real = self._resolve(path)
        try:
            os.mkdir(real)
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)
        return paramiko.SFTP_OK

    def rmdir(self, path):
        real = self._resolve(path)
        try:
            os.rmdir(real)
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)
        return paramiko.SFTP_OK

    def rename(self, oldpath, newpath):
        old = self._resolve(oldpath)
        new = self._resolve(newpath)
        try:
            os.rename(old, new)
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)
        return paramiko.SFTP_OK


def handle_client(client, addr, host_key):
    print(f"connection from {addr}", flush=True)
    t = paramiko.Transport(client)
    t.add_server_key(host_key)
    try:
        t.start_server(StubServer())
    except paramiko.SSHException as e:
        print(f"start_server failed: {e}", flush=True)
        t.close()
        return
    chan = t.accept(20)
    if chan is None:
        print("no channel", flush=True)
        t.close()
        return
    try:
        sftpd = SFTPServer(chan, "sftp", StubSFTPInterface, "", 0, 0, [])
        # just block
        import time
        while t.is_active():
            time.sleep(0.5)
    except Exception as e:
        print(f"sftp server error: {e}", flush=True)
        traceback.print_exc()
    finally:
        t.close()


def start():
    os.makedirs(ROOT, exist_ok=True)
    host_key = RSAKey.generate(2048)

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((HOST, PORT))
    sock.listen(100)
    print(f"SFTP server listening on {HOST}:{PORT}, root={ROOT}", flush=True)

    while True:
        client, addr = sock.accept()
        threading.Thread(target=handle_client, args=(client, addr, host_key), daemon=True).start()


if __name__ == "__main__":
    start()
