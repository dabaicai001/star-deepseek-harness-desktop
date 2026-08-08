"""SSH server with direct-tcpip (TCP forwarding) support for local gateway testing.
Listens on 127.0.0.1:2223, user: testuser / testpass. Forwards direct-tcpip
channels to the real destination (server-side egress, like a real SSH server).
"""
import socket
import threading
import paramiko
from paramiko import RSAKey

HOST = "127.0.0.1"
PORT = 2223


class ForwardServer(paramiko.ServerInterface):
    def __init__(self):
        self.destinations = {}

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

    def check_channel_direct_tcpip_request(self, chanid, origin, destination):
        print(f"direct-tcpip request chan={chanid} origin={origin} dest={destination}", flush=True)
        self.destinations[chanid] = destination
        return paramiko.OPEN_SUCCEEDED


def pump(chan, sock):
    def chan_to_sock():
        try:
            while True:
                data = chan.recv(32768)
                if not data:
                    break
                sock.sendall(data)
        except Exception:
            pass
        finally:
            try:
                sock.shutdown(socket.SHUT_WR)
            except Exception:
                pass

    def sock_to_chan():
        try:
            while True:
                data = sock.recv(32768)
                if not data:
                    break
                chan.sendall(data)
        except Exception:
            pass
        finally:
            try:
                chan.shutdown_write()
            except Exception:
                pass

    t1 = threading.Thread(target=chan_to_sock, daemon=True)
    t2 = threading.Thread(target=sock_to_chan, daemon=True)
    t1.start()
    t2.start()
    t1.join()
    t2.join()
    chan.close()
    sock.close()


def handle_client(client):
    transport = paramiko.Transport(client)
    transport.add_server_key(RSAKey.generate(2048))
    server = ForwardServer()
    transport.start_server(server=server)
    while transport.is_active():
        chan = transport.accept(20)
        if chan is None:
            continue
        dest = server.destinations.pop(chan.get_id(), None)
        if dest is None:
            chan.close()
            continue
        host, port = dest
        try:
            sock = socket.create_connection((host, port), timeout=15)
        except Exception as e:
            print(f"upstream connect to {host}:{port} failed: {e}", flush=True)
            chan.close()
            continue
        threading.Thread(target=pump, args=(chan, sock), daemon=True).start()


def main():
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind((HOST, PORT))
    listener.listen(5)
    print(f"SSH direct-tcpip test server on {HOST}:{PORT}", flush=True)
    while True:
        client, _ = listener.accept()
        threading.Thread(target=handle_client, args=(client,), daemon=True).start()


if __name__ == "__main__":
    main()
