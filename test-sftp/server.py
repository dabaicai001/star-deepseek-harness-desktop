"""Minimal paramiko SSH/SFTP server for local testing.
Listens on 127.0.0.1:2222, user: testuser / testpass.

P3a(dsh 主壳融合)起支持完整 SSH 链路:
- shell channel(pty + shell 请求)→ 伪 shell:回显输入、对 echo/pwd/whoami
  给固定应答,exit 关闭 —— 供 SSH 终端页「输命令、看回显」实测
- exec channel → 固定应答 + exit-status 0 —— 供 ssh_exec(AI 静默命令)链路
- sftp subsystem → SFTPServer(root ./sftp_root)—— 供 SFTP 面板实测

host key 持久化在 host_key.pem(首次启动生成),fingerprint 稳定,
便于预置进 StarHub known_hosts 做无人值守冒烟。
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
KEY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "host_key.pem")


def run_stub_shell(chan):
    """伪交互 shell:回显 + 固定应答,让终端页的输入输出链路可被实测。"""
    prompt = b"testuser@starhub-stub:~$ "
    canned = {
        "pwd": "/home/testuser",
        "whoami": "testuser",
        "hostname": "starhub-stub",
    }
    try:
        chan.send(b"Welcome to StarHub stub SSH shell (test-sftp/server.py)\r\n")
        chan.send(prompt)
        buf = b""
        while True:
            data = chan.recv(1024)
            if not data:
                break
            # 终端回显由服务端承担(PTY 语义)
            chan.send(data)
            buf += data
            while b"\r" in buf:
                line, buf = buf.split(b"\r", 1)
                cmd = line.decode("utf-8", "replace").strip()
                chan.send(b"\r\n")
                if cmd in ("exit", "quit", "logout"):
                    chan.send(b"logout\r\n")
                    chan.close()
                    return
                if cmd:
                    if cmd.startswith("echo "):
                        chan.send(cmd[5:].encode() + b"\r\n")
                    elif cmd in canned:
                        chan.send(canned[cmd].encode() + b"\r\n")
                    else:
                        chan.send(f"stub-sh: {cmd}: command not found\r\n".encode())
                chan.send(prompt)
    except (OSError, EOFError):
        pass
    finally:
        try:
            chan.close()
        except Exception:
            pass


def run_stub_exec(chan, command):
    """exec channel:固定应答 + exit-status 0(russh exec 需要 exit status 收口)。"""
    try:
        cmd = command.decode("utf-8", "replace") if isinstance(command, bytes) else str(command)
        chan.sendall(f"stub-exec: {cmd}\n".encode())
        chan.send_exit_status(0)
    except (OSError, EOFError):
        pass
    finally:
        try:
            chan.close()
        except Exception:
            pass


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

    def check_channel_pty_request(self, channel, term, width, height,
                                  pixelwidth, pixelheight, modes):
        print(f"pty request: chan={channel.get_id()} term={term} {width}x{height}", flush=True)
        return True

    def check_channel_window_change_request(self, channel, width, height,
                                            pixelwidth, pixelheight):
        return True

    def check_channel_shell_request(self, channel):
        # 回调里直接拿到 channel 对象,就地起 shell 线程;
        # 不在 accept() 后再判型(accept 返回时 shell 请求可能还没到,有竞态)
        print(f"shell request: chan={channel.get_id()}", flush=True)
        threading.Thread(target=run_stub_shell, args=(channel,), daemon=True).start()
        return True

    def check_channel_exec_request(self, channel, command):
        cmd = command.decode("utf-8", "replace") if isinstance(command, bytes) else str(command)
        print(f"exec request: chan={channel.get_id()} cmd={cmd[:80]!r}", flush=True)
        threading.Thread(target=run_stub_exec, args=(channel, command), daemon=True).start()
        return True

    def check_channel_subsystem_request(self, channel, name):
        ok = super().check_channel_subsystem_request(channel, name)
        print(f"subsystem request: chan={channel.get_id()} name={name} -> {ok}", flush=True)
        return ok


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
        # paramiko ≥5:flags 已由 SFTPServer._convert_pflags 转成 os 模块的
        # O_* 位(不再是 SFTP_FLAG_*);协议规定一律二进制模式(Windows 必须
        # 补 O_BINARY,否则 \n 会被转义成 \r\n,下载回来的文件字节对不上)
        print(f"sftp open: path={path} flags={flags:#x}", flush=True)
        real = self._resolve(path)
        try:
            fd = os.open(real, flags | os.O_BINARY, 0o644)
            handle = SFTPHandle(flags)
            handle.filename = real
            if flags & os.O_WRONLY or flags & os.O_RDWR:
                handle.writefile = os.fdopen(fd, "wb", -1)
                handle.readfile = handle.writefile
            else:
                handle.readfile = os.fdopen(fd, "rb", -1)
            return handle
        except OSError as e:
            traceback.print_exc()
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
    # sftp subsystem 由 paramiko 的 subsystem handler 自动接管(自己的线程),
    # shell / exec channel 由 StubServer 的回调就地起线程
    t.set_subsystem_handler("sftp", SFTPServer, StubSFTPInterface)
    try:
        t.start_server(server=StubServer())
    except paramiko.SSHException as e:
        print(f"start_server failed: {e}", flush=True)
        t.close()
        return
    try:
        # accept 队列只用于让 transport 持续分发 channel;shell/exec/sftp
        # 都已在回调/子系统 handler 里接管,这里拿到后直接放行
        while t.is_active():
            chan = t.accept(5)
            if chan is not None:
                print(f"channel accepted: id={chan.get_id()}", flush=True)
    except Exception as e:
        print(f"server error: {e}", flush=True)
        traceback.print_exc()
    finally:
        t.close()


def load_or_generate_host_key():
    """host key 持久化:重启 fingerprint 不变,可预置 known_hosts 做无人值守冒烟。"""
    if os.path.exists(KEY_FILE):
        return RSAKey.from_private_key_file(KEY_FILE)
    key = RSAKey.generate(2048)
    key.write_private_key_file(KEY_FILE)
    return key


def start():
    os.makedirs(ROOT, exist_ok=True)
    host_key = load_or_generate_host_key()

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
