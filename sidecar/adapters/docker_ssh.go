package adapters

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// DockerSSHConfig describes the SSH asset selected by the user. Host keys are
// supplied by the Tauri trusted-host store; the sidecar never silently accepts
// an unknown SSH server.
type DockerSSHConfig struct {
	Host         string `json:"host"`
	Port         int    `json:"port"`
	Username     string `json:"username"`
	Password     string `json:"password,omitempty"`
	PrivateKey   string `json:"privateKey,omitempty"`
	Passphrase   string `json:"passphrase,omitempty"`
	KnownHostKey string `json:"knownHostKey"`

	JumpHost         string `json:"jumpHost,omitempty"`
	JumpPort         int    `json:"jumpPort,omitempty"`
	JumpUsername     string `json:"jumpUsername,omitempty"`
	JumpPassword     string `json:"jumpPassword,omitempty"`
	JumpPrivateKey   string `json:"jumpPrivateKey,omitempty"`
	JumpPassphrase   string `json:"jumpPassphrase,omitempty"`
	JumpKnownHostKey string `json:"jumpKnownHostKey,omitempty"`

	Protocol string `json:"protocol,omitempty"`
}

func newDockerSSHTransport(info *DockerConnInfo) (*http.Transport, []*ssh.Client, error) {
	if info.SSH == nil {
		return nil, nil, fmt.Errorf("docker SSH transport requires an SSH configuration")
	}
	sshConfig := info.SSH
	targetConfig, err := buildSSHClientConfig(
		sshConfig.Username,
		sshConfig.Password,
		sshConfig.PrivateKey,
		sshConfig.Passphrase,
		sshConfig.KnownHostKey,
	)
	if err != nil {
		return nil, nil, fmt.Errorf("docker SSH target config: %w", err)
	}
	targetAddr := net.JoinHostPort(sshConfig.Host, defaultPort(sshConfig.Port))
	var clients []*ssh.Client
	var targetClient *ssh.Client

	if sshConfig.JumpHost != "" {
		jumpConfig, configErr := buildSSHClientConfig(
			fallback(sshConfig.JumpUsername, sshConfig.Username),
			sshConfig.JumpPassword,
			sshConfig.JumpPrivateKey,
			sshConfig.JumpPassphrase,
			sshConfig.JumpKnownHostKey,
		)
		if configErr != nil {
			return nil, nil, fmt.Errorf("docker SSH jump config: %w", configErr)
		}
		jumpAddr := net.JoinHostPort(sshConfig.JumpHost, defaultPort(sshConfig.JumpPort))
		jumpClient, dialErr := ssh.Dial("tcp", jumpAddr, jumpConfig)
		if dialErr != nil {
			return nil, nil, fmt.Errorf("connect SSH jump host %s: %w", jumpAddr, dialErr)
		}
		clients = append(clients, jumpClient)
		targetConn, dialErr := jumpClient.Dial("tcp", targetAddr)
		if dialErr != nil {
			closeSSHClients(clients)
			return nil, nil, fmt.Errorf("open SSH tunnel to %s: %w", targetAddr, dialErr)
		}
		clientConn, channels, requests, handshakeErr := ssh.NewClientConn(targetConn, targetAddr, targetConfig)
		if handshakeErr != nil {
			_ = targetConn.Close()
			closeSSHClients(clients)
			return nil, nil, fmt.Errorf("authenticate SSH target %s: %w", targetAddr, handshakeErr)
		}
		targetClient = ssh.NewClient(clientConn, channels, requests)
	} else {
		targetClient, err = ssh.Dial("tcp", targetAddr, targetConfig)
		if err != nil {
			return nil, nil, fmt.Errorf("connect SSH target %s: %w", targetAddr, err)
		}
	}
	clients = append(clients, targetClient)

	socketPath := info.SocketPath
	if socketPath == "" {
		socketPath = "/var/run/docker.sock"
	}
	useSudo := sshConfig.Protocol == "unix-over-nc-sudo"
	dialer := &dockerSSHUnixDialer{
		client:     targetClient,
		socketPath: socketPath,
		useSudo:    useSudo,
	}
	return &http.Transport{
		DialContext:         dialer.DialContext,
		DisableCompression:  true,
		ForceAttemptHTTP2:   false,
		MaxIdleConns:        8,
		MaxIdleConnsPerHost: 8,
		IdleConnTimeout:     30 * time.Second,
	}, clients, nil
}

func buildSSHClientConfig(
	username string,
	password string,
	privateKey string,
	passphrase string,
	knownHostKey string,
) (*ssh.ClientConfig, error) {
	if username == "" {
		return nil, fmt.Errorf("username is required")
	}
	hostKey, _, _, _, err := ssh.ParseAuthorizedKey([]byte(strings.TrimSpace(knownHostKey)))
	if err != nil {
		return nil, fmt.Errorf("trusted host key is unavailable; connect and trust this SSH asset first")
	}
	authMethods := make([]ssh.AuthMethod, 0, 2)
	if privateKey != "" {
		var signer ssh.Signer
		if passphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(privateKey), []byte(passphrase))
		} else {
			signer, err = ssh.ParsePrivateKey([]byte(privateKey))
		}
		if err != nil {
			return nil, fmt.Errorf("parse private key: %w", err)
		}
		authMethods = append(authMethods, ssh.PublicKeys(signer))
	}
	if password != "" {
		authMethods = append(authMethods, ssh.Password(password))
	}
	if len(authMethods) == 0 {
		return nil, fmt.Errorf("password or private key is required")
	}
	return &ssh.ClientConfig{
		User:              username,
		Auth:              authMethods,
		HostKeyCallback:   ssh.FixedHostKey(hostKey),
		HostKeyAlgorithms: []string{hostKey.Type()},
		Timeout:           15 * time.Second,
	}, nil
}

type dockerSSHUnixDialer struct {
	client     *ssh.Client
	socketPath string
	useSudo    bool
}

func (d *dockerSSHUnixDialer) DialContext(ctx context.Context, _, _ string) (net.Conn, error) {
	type result struct {
		conn net.Conn
		err  error
	}
	resultCh := make(chan result, 1)
	go func() {
		conn, err := d.open()
		select {
		case resultCh <- result{conn: conn, err: err}:
		case <-ctx.Done():
			if conn != nil {
				_ = conn.Close()
			}
		}
	}()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case result := <-resultCh:
		return result.conn, result.err
	}
}

func (d *dockerSSHUnixDialer) open() (net.Conn, error) {
	session, err := d.client.NewSession()
	if err != nil {
		return nil, fmt.Errorf("open SSH channel: %w", err)
	}
	stdin, err := session.StdinPipe()
	if err != nil {
		_ = session.Close()
		return nil, err
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		_ = session.Close()
		return nil, err
	}
	var stderr bytes.Buffer
	session.Stderr = &stderr

	command := fmt.Sprintf("nc -U %s", shellQuote(d.socketPath))
	if d.useSudo {
		command = "sudo -n " + command
	}
	if err := session.Start(command); err != nil {
		_ = session.Close()
		return nil, fmt.Errorf("start %q: %w", command, err)
	}
	return &sshCommandConn{
		session: session,
		reader:  stdout,
		writer:  stdin,
		stderr:  &stderr,
	}, nil
}

type sshCommandConn struct {
	session *ssh.Session
	reader  io.Reader
	writer  io.WriteCloser
	stderr  *bytes.Buffer
}

func (c *sshCommandConn) Read(buffer []byte) (int, error) {
	n, err := c.reader.Read(buffer)
	if err != nil && c.stderr.Len() > 0 {
		return n, fmt.Errorf("%s: %w", strings.TrimSpace(c.stderr.String()), err)
	}
	return n, err
}

func (c *sshCommandConn) Write(buffer []byte) (int, error)   { return c.writer.Write(buffer) }
func (c *sshCommandConn) LocalAddr() net.Addr                { return dockerTunnelAddr("local") }
func (c *sshCommandConn) RemoteAddr() net.Addr               { return dockerTunnelAddr("remote") }
func (c *sshCommandConn) SetDeadline(_ time.Time) error      { return nil }
func (c *sshCommandConn) SetReadDeadline(_ time.Time) error  { return nil }
func (c *sshCommandConn) SetWriteDeadline(_ time.Time) error { return nil }

func (c *sshCommandConn) Close() error {
	_ = c.writer.Close()
	return c.session.Close()
}

type dockerTunnelAddr string

func (a dockerTunnelAddr) Network() string { return "ssh-unix" }
func (a dockerTunnelAddr) String() string  { return string(a) }

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func defaultPort(port int) string {
	if port <= 0 {
		port = 22
	}
	return fmt.Sprintf("%d", port)
}

func fallback(value, defaultValue string) string {
	if value != "" {
		return value
	}
	return defaultValue
}

func closeSSHClients(clients []*ssh.Client) {
	for index := len(clients) - 1; index >= 0; index-- {
		_ = clients[index].Close()
	}
}
