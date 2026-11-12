CC ?= cc
CFLAGS ?= -O2
OUT ?= ../build

$(OUT)/pam_stackpilot.so: pam_stackpilot.c
	mkdir -p $(OUT)
	$(CC) $(CFLAGS) -std=c11 -Wall -Wextra -Werror -fPIC -fstack-protector-strong -D_FORTIFY_SOURCE=2 -shared -Wl,-z,relro,-z,now -o $@ $< -lpam

.PHONY: clean
clean:
	rm -f $(OUT)/pam_stackpilot.so
