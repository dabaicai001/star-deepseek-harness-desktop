"""server.py 的客户端自测:shell 回显 / exec / sftp 列目录与上传下载。"""
import sys
import time
import paramiko

HOST, PORT, USER, PASS = "127.0.0.1", 2222, "testuser", "testpass"

failures = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name} {detail}", flush=True)
    if not ok:
        failures.append(name)


# ---- shell:回显 + 固定应答 ----
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, PORT, USER, PASS, timeout=10, look_for_keys=False, allow_agent=False)
chan = c.invoke_shell(term="xterm-256color", width=80, height=24)
time.sleep(0.5)
banner = chan.recv(4096).decode("utf-8", "replace")
check("shell banner", "starhub-stub" in banner, repr(banner[:60]))
chan.send("whoami\r")
time.sleep(0.5)
out = chan.recv(4096).decode("utf-8", "replace")
check("shell echo+answer", "whoami" in out and "testuser" in out, repr(out[:120]))
chan.send("exit\r")
time.sleep(0.3)

# ---- exec ----
stdin, stdout, stderr = c.exec_command("ls /")
check("exec", "stub-exec: ls /" in stdout.read().decode(), "")

# ---- sftp ----
sftp = c.open_sftp()
names = sftp.listdir("/")
check("sftp listdir", isinstance(names, list), repr(names[:5]))
sftp.open("/p3a_probe.txt", "w").write("starhub-p3a")
check("sftp upload", "p3a_probe.txt" in sftp.listdir("/"), "")
data = sftp.open("/p3a_probe.txt", "r").read().decode()
check("sftp download", data == "starhub-p3a", repr(data))
sftp.remove("/p3a_probe.txt")
c.close()

print("RESULT:", "ALL PASS" if not failures else f"FAILURES: {failures}", flush=True)
sys.exit(0 if not failures else 1)
