# The compose environment's NTP image (development-environment/ntp), with -x: in a pod chrony may not set the clock.
FROM alpine:3.21
RUN apk add --no-cache chrony
COPY chrony.conf /etc/chrony/chrony.conf
EXPOSE 123/udp
CMD ["chronyd", "-d", "-x", "-f", "/etc/chrony/chrony.conf"]
