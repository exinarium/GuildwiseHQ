# A throwaway "VPS" for the tests of guided connect and of moving to a new server: sshd, two users with a password, and a tiny httpd (busybox-extras) that
# the fake docker of the move tests uses as "the app".
FROM alpine:3.20
RUN apk add --no-cache openssh bash busybox-extras \
 && adduser -D -s /bin/sh deploy \
 && echo 'root:rootpw-for-tests' | chpasswd \
 && echo 'deploy:deploypw-for-tests' | chpasswd \
 && ssh-keygen -A \
 && printf 'PasswordAuthentication yes\nPermitRootLogin yes\nPubkeyAuthentication yes\nUsePAM no\nAllowTcpForwarding no\nX11Forwarding no\n' >> /etc/ssh/sshd_config
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
