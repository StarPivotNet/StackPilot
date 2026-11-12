#define _GNU_SOURCE
#include <sys/stat.h>
#include <sys/types.h>
#include <fcntl.h>
#include <unistd.h>
#include <pwd.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <errno.h>
#include <limits.h>

/* This binary is not setuid. Only an exact sudoers command grants root access. */
static int unit_valid(const char *value) {
    size_t length = strlen(value);
    if (length < 9 || length > 136 || strcmp(value + length - 8, ".service") != 0 || strspn(value, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.@-") != length) return 0;
    const char *prefixes[] = { "stackpilot-", "stackpilot.", "systemd-", "systemd.", "user@", "dbus.", "dbus-", "polkit.", "polkit-", NULL };
    for (int i = 0; prefixes[i]; i++) if (strncasecmp(value, prefixes[i], strlen(prefixes[i])) == 0) return 0;
    return strcasecmp(value, "ssh.service") != 0 && strcasecmp(value, "sshd.service") != 0 && strcasecmp(value, "cron.service") != 0 && strcasecmp(value, "atd.service") != 0;
}
int main(int argc, char **argv) {
    if (geteuid() != 0 || getuid() != 0 || argc != 3 || !unit_valid(argv[2])) return 1;
    if (strcmp(argv[1], "start") != 0 && strcmp(argv[1], "stop") != 0 && strcmp(argv[1], "restart") != 0) return 1;
    const char *user = getenv("SUDO_USER"), *uid = getenv("SUDO_UID");
    if (!user || !uid || strncmp(user, "sp_", 3) != 0 || strlen(user) < 4 || strlen(user) > 28 || strspn(user + 3, "abcdefghijklmnopqrstuvwxyz0123456789") != strlen(user) - 3 || !*uid || strspn(uid, "0123456789") != strlen(uid)) return 1;
    errno = 0; char *end = NULL; unsigned long number = strtoul(uid, &end, 10);
    if (errno || !end || *end || number < 1000 || number > UINT_MAX) return 1;
    struct passwd data, *entry = NULL; char lookup[16384];
    if (getpwnam_r(user, &data, lookup, sizeof lookup, &entry) || !entry || entry->pw_uid != (uid_t)number || entry->pw_uid == 0) return 1;
    int directory = open("/etc/stackpilot-ssh-helper/service-grants", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (directory < 0) return 1;
    struct stat metadata;
    if (fstat(directory, &metadata) || metadata.st_uid != 0 || (metadata.st_mode & 0077)) { close(directory); return 1; }
    int file = openat(directory, user, O_RDONLY | O_NOFOLLOW | O_CLOEXEC); close(directory);
    if (file < 0) return 1;
    if (fstat(file, &metadata) || !S_ISREG(metadata.st_mode) || metadata.st_uid != 0 || metadata.st_nlink != 1 || (metadata.st_mode & 0077) || metadata.st_size > 16384) { close(file); return 1; }
    char contents[16385]; size_t used = 0;
    while (used < sizeof contents - 1) { ssize_t count = read(file, contents + used, sizeof contents - 1 - used); if (count < 0 && errno == EINTR) continue; if (count < 0) { close(file); return 1; } if (count == 0) break; used += (size_t)count; }
    close(file); if (!used || memchr(contents, 0, used)) return 1; contents[used] = 0;
    int permitted = 0; char *line = contents;
    while (*line) { char *newline = strchr(line, '\n'); if (!newline) return 1; *newline = 0; if (!unit_valid(line)) return 1; if (strcmp(line, argv[2]) == 0) permitted = 1; line = newline + 1; }
    if (!permitted) return 1;
    char *arguments[] = { "/usr/bin/systemctl", argv[1], "--", argv[2], NULL };
    char *environment[] = { "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C", "LC_ALL=C", "SYSTEMD_COLORS=0", NULL };
    execve(arguments[0], arguments, environment); return 1;
}
