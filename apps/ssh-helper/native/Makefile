CC ?= cc
CFLAGS ?= -O2
OUT ?= ../build

.PHONY: all
all: $(OUT)/pam_stackpilot.so $(OUT)/stackpilot-ssh-service

$(OUT)/pam_stackpilot.so: pam_stackpilot.c
	mkdir -p $(OUT)
	$(CC) $(CFLAGS) -std=c11 -Wall -Wextra -Werror -fPIC -fstack-protector-strong -D_FORTIFY_SOURCE=2 -shared -Wl,-z,relro,-z,now -o $@ $< -lpam

$(OUT)/stackpilot-ssh-service: stackpilot_ssh_service.c
	mkdir -p $(OUT)
	$(CC) $(CFLAGS) -std=c11 -Wall -Wextra -Werror -fstack-protector-strong -D_FORTIFY_SOURCE=2 -Wl,-z,relro,-z,now -o $@ $<

.PHONY: clean
clean:
	rm -f $(OUT)/pam_stackpilot.so $(OUT)/stackpilot-ssh-service
