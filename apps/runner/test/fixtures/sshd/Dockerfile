# A throwaway "VPS" for the tests of guided connect: only sshd, two users with a password, nothing else.
FROM alpine:3.20
RUN apk add --no-cache openssh bash \
 && adduser -D -s /bin/sh deploy \
 && echo 'root:rootpw-for-tests' | chpasswd \
 && echo 'deploy:deploypw-for-tests' | chpasswd \
 && ssh-keygen -A \
 && printf 'PasswordAuthentication yes\nPermitRootLogin yes\nPubkeyAuthentication yes\nUsePAM no\nAllowTcpForwarding no\nX11Forwarding no\n' >> /etc/ssh/sshd_config
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
