# A throwaway git host for the tests of private packs over ssh: sshd with a `git` user that logs in by key only, and git.
FROM alpine:3.20
RUN apk add --no-cache openssh git \
 && adduser -D -s /bin/sh git \
 && echo 'git:unusable-password-for-tests' | chpasswd \
 && ssh-keygen -A \
 && printf 'PasswordAuthentication no\nPubkeyAuthentication yes\nPermitRootLogin no\nUsePAM no\nAllowTcpForwarding no\nX11Forwarding no\n' >> /etc/ssh/sshd_config \
 && mkdir -p /home/git/.ssh /srv && chown -R git:git /home/git /srv && chmod 700 /home/git/.ssh
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
