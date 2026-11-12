#define _GNU_SOURCE
#include <security/pam_appl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int conversation(int count, const struct pam_message **messages, struct pam_response **result, void *data) {
    if (count <= 0 || count > PAM_MAX_NUM_MSG) return PAM_CONV_ERR;
    struct pam_response *responses = calloc((size_t)count, sizeof *responses);
    if (!responses) return PAM_BUF_ERR;
    for (int i = 0; i < count; i++) {
        if (messages[i]->msg_style == PAM_PROMPT_ECHO_OFF) {
            responses[i].resp = strdup((const char *)data);
            if (!responses[i].resp) { for (int j = 0; j < i; j++) free(responses[j].resp); free(responses); return PAM_BUF_ERR; }
        }
    }
    *result = responses; return PAM_SUCCESS;
}
int main(int argc, char **argv) {
    if (argc != 5) return 2;
    struct pam_conv conv = { .conv = conversation, .appdata_ptr = argv[3] }; pam_handle_t *pamh = NULL;
    int result = pam_start_confdir("sshd", argv[2], &conv, argv[1], &pamh);
    if (result != PAM_SUCCESS) return 3;
    result = pam_authenticate(pamh, 0);
    if (result == PAM_SUCCESS && strcmp(argv[4], "session") == 0) { result = pam_acct_mgmt(pamh, 0); if (result == PAM_SUCCESS) result = pam_open_session(pamh, 0); if (result == PAM_SUCCESS) result = pam_close_session(pamh, 0); }
    printf("%d\n", result); pam_end(pamh, result); return result == PAM_SUCCESS ? 0 : 1;
}
