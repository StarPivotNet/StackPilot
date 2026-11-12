#define _GNU_SOURCE
#include <security/pam_modules.h>
#include <security/pam_ext.h>
#include <security/pam_appl.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/time.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>

/* Fixed root-only socket. No path, executable or environment is supplied by a user. */
static const char socket_path[] = "/run/stackpilot-ssh-helper/pam.sock";
static int send_all(int fd, const char *value, size_t length) {
    while (length) { ssize_t n = send(fd, value, length, MSG_NOSIGNAL); if (n < 0 && errno == EINTR) continue; if (n <= 0) return -1; value += n; length -= (size_t)n; } return 0;
}
static int exchange(const char *value) {
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) return PAM_AUTHINFO_UNAVAIL;
    struct timeval timeout = { .tv_sec = 20, .tv_usec = 0 };
    if (setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout) || setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof timeout)) { close(fd); return PAM_AUTHINFO_UNAVAIL; }
    struct sockaddr_un address = { .sun_family = AF_UNIX };
    memcpy(address.sun_path, socket_path, sizeof socket_path);
    if (connect(fd, (struct sockaddr *)&address, sizeof address)) { close(fd); return PAM_AUTHINFO_UNAVAIL; }
    struct ucred peer; socklen_t size = sizeof peer;
    if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &peer, &size) || size != sizeof peer || peer.uid != 0) { close(fd); return PAM_AUTHINFO_UNAVAIL; }
    if (send_all(fd, value, strlen(value))) { close(fd); return PAM_AUTHINFO_UNAVAIL; }
    char reply[4] = {0}; size_t used = 0;
    while (used < sizeof reply - 1) { ssize_t n = recv(fd, reply + used, sizeof reply - 1 - used, 0); if (n < 0 && errno == EINTR) continue; if (n <= 0) break; used += (size_t)n; if (memchr(reply, '\n', used)) break; }
    close(fd); return used == 3 && memcmp(reply, "OK\n", 3) == 0 ? PAM_SUCCESS : PAM_AUTH_ERR;
}
static int account(pam_handle_t *pamh, const char **user) {
    const void *service = NULL;
    if (geteuid() != 0 || pam_get_item(pamh, PAM_SERVICE, &service) != PAM_SUCCESS || service == NULL || strcmp(service, "sshd") != 0) return PAM_AUTH_ERR;
    if (pam_get_user(pamh, user, NULL) != PAM_SUCCESS || *user == NULL || strncmp(*user, "sp_", 3) != 0) return PAM_AUTH_ERR;
    size_t length = strlen(*user); if (length < 4 || length > 28 || strspn(*user + 3, "abcdefghijklmnopqrstuvwxyz0123456789") != length - 3) return PAM_AUTH_ERR;
    return PAM_SUCCESS;
}
PAM_EXTERN int pam_sm_authenticate(pam_handle_t *pamh, int flags, int argc, const char **argv) {
    (void)flags; (void)argc; (void)argv;
    const char *user = NULL, *password = NULL; int result = account(pamh, &user);
    if (result != PAM_SUCCESS) return result;
    result = pam_get_authtok(pamh, PAM_AUTHTOK, &password, "Temporary SSH password: ");
    if (result != PAM_SUCCESS || password == NULL || strlen(password) != 43 || strspn(password, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-") != 43) return PAM_AUTH_ERR;
    char message[512]; int count = snprintf(message, sizeof message, "{\"operation\":\"authenticate\",\"monitorPid\":%ld,\"phasePid\":%ld,\"account\":\"%s\",\"password\":\"%s\"}\n", (long)getppid(), (long)getpid(), user, password);
    if (count < 0 || (size_t)count >= sizeof message) { explicit_bzero(message, sizeof message); return PAM_AUTH_ERR; }
    result = exchange(message); explicit_bzero(message, sizeof message); return result;
}
static int check(pam_handle_t *pamh) {
    const char *user = NULL; int result = account(pamh, &user); if (result != PAM_SUCCESS) return result;
    char message[256]; int count = snprintf(message, sizeof message, "{\"operation\":\"check\",\"phasePid\":%ld,\"account\":\"%s\"}\n", (long)getpid(), user);
    if (count < 0 || (size_t)count >= sizeof message) return PAM_AUTH_ERR;
    return exchange(message);
}
PAM_EXTERN int pam_sm_acct_mgmt(pam_handle_t *pamh, int flags, int argc, const char **argv) { (void)flags; (void)argc; (void)argv; return check(pamh); }
PAM_EXTERN int pam_sm_open_session(pam_handle_t *pamh, int flags, int argc, const char **argv) { (void)flags; (void)argc; (void)argv; return check(pamh); }
PAM_EXTERN int pam_sm_close_session(pam_handle_t *pamh, int flags, int argc, const char **argv) { (void)pamh; (void)flags; (void)argc; (void)argv; return PAM_SUCCESS; }
PAM_EXTERN int pam_sm_setcred(pam_handle_t *pamh, int flags, int argc, const char **argv) { (void)pamh; (void)flags; (void)argc; (void)argv; return PAM_SUCCESS; }
