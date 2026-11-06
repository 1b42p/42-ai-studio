FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    curl \
    git \
    procps \
    ca-certificates \
    util-linux \
    && rm -rf /var/lib/apt/lists/*

# Node 24 из NodeSource. Мажор закреплён скриптом setup_24.x.
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs \
    && node --version | grep -q '^v24\.' \
    && rm -rf /var/lib/apt/lists/*

# Библиотеки Chrome для Debian и шрифты кириллицы с эмодзи.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 \
    libdbus-1-3 \
    libatk1.0-0 \
    libgbm-dev \
    libasound2 \
    libxrandr2 \
    libxkbcommon-dev \
    libxfixes3 \
    libxcomposite1 \
    libxdamage1 \
    libpango-1.0-0 \
    libcairo2 \
    libcups2 \
    libatk-bridge2.0-0 \
    fonts-dejavu-core \
    fonts-liberation \
    fonts-noto-color-emoji \
    fontconfig \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f

# ARG после FROM: объявление до FROM в следующих командах не видно.
ARG REMOTION_VERSION=4.0.538
ARG ZOD_VERSION=4.5.4

# Пользователь песочницы — root, поэтому USER и chown не задаются.
# /opt/remotion остаётся записываемым для кэша рендера из копии проекта.
RUN mkdir -p /opt/remotion/src

# embed /opt/remotion/package.json
# {
#   "name": "remotion-template",
#   "private": true,
#   "version": "1.0.0"
# }
# end embed
RUN echo 'ewogICJuYW1lIjogInJlbW90aW9uLXRlbXBsYXRlIiwKICAicHJpdmF0ZSI6IHRydWUsCiAgInZlcnNpb24iOiAiMS4wLjAiCn0K' | base64 -d > /opt/remotion/package.json

WORKDIR /opt/remotion
RUN npm install --save-exact --no-audit --no-fund \
    "remotion@${REMOTION_VERSION}" \
    "@remotion/cli@${REMOTION_VERSION}" \
    "@remotion/media@${REMOTION_VERSION}" \
    "@remotion/captions@${REMOTION_VERSION}" \
    "@remotion/google-fonts@${REMOTION_VERSION}" \
    "@remotion/transitions@${REMOTION_VERSION}" \
    "@remotion/shapes@${REMOTION_VERSION}" \
    "@remotion/layout-utils@${REMOTION_VERSION}" \
    "@remotion/effects@${REMOTION_VERSION}" \
    "@remotion/paths@${REMOTION_VERSION}" \
    "@remotion/noise@${REMOTION_VERSION}" \
    "@remotion/motion-blur@${REMOTION_VERSION}" \
    "@remotion/gif@${REMOTION_VERSION}" \
    "@remotion/zod-types@${REMOTION_VERSION}" \
    "react@19.2.3" \
    "react-dom@19.2.3" \
    "zod@${ZOD_VERSION}" \
    "typescript@5.9.3" \
    "@types/react@19.2.7" \
    "@types/react-dom@19.2.3" \
    && npx remotion browser ensure \
    && npm cache clean --force \
    && rm -rf /root/.npm

# embed /opt/remotion/tsconfig.json
# {
#   "compilerOptions": {
#     "target": "ES2018",
#     "module": "Preserve",
#     "moduleResolution": "Bundler",
#     "jsx": "react-jsx",
#     "strict": true,
#     "noEmit": true,
#     "lib": ["es2015"],
#     "esModuleInterop": true,
#     "skipLibCheck": true,
#     "forceConsistentCasingInFileNames": true,
#     "noUnusedLocals": true
#   },
#   "exclude": ["remotion.config.ts"]
# }
# end embed
RUN echo 'ewogICJjb21waWxlck9wdGlvbnMiOiB7CiAgICAidGFyZ2V0IjogIkVTMjAxOCIsCiAgICAibW9kdWxlIjogIlByZXNlcnZlIiwKICAgICJtb2R1bGVSZXNvbHV0aW9uIjogIkJ1bmRsZXIiLAogICAgImpzeCI6ICJyZWFjdC1qc3giLAogICAgInN0cmljdCI6IHRydWUsCiAgICAibm9FbWl0IjogdHJ1ZSwKICAgICJsaWIiOiBbImVzMjAxNSJdLAogICAgImVzTW9kdWxlSW50ZXJvcCI6IHRydWUsCiAgICAic2tpcExpYkNoZWNrIjogdHJ1ZSwKICAgICJmb3JjZUNvbnNpc3RlbnRDYXNpbmdJbkZpbGVOYW1lcyI6IHRydWUsCiAgICAibm9VbnVzZWRMb2NhbHMiOiB0cnVlCiAgfSwKICAiZXhjbHVkZSI6IFsicmVtb3Rpb24uY29uZmlnLnRzIl0KfQo=' | base64 -d > /opt/remotion/tsconfig.json

# embed /opt/remotion/remotion.config.ts
# import { Config } from "@remotion/cli/config";
#
# Config.setRspack(true);
# Config.setVideoImageFormat("jpeg");
# Config.setOverwriteOutput(true);
# end embed
RUN echo 'aW1wb3J0IHsgQ29uZmlnIH0gZnJvbSAiQHJlbW90aW9uL2NsaS9jb25maWciOwoKQ29uZmlnLnNldFJzcGFjayh0cnVlKTsKQ29uZmlnLnNldFZpZGVvSW1hZ2VGb3JtYXQoImpwZWciKTsKQ29uZmlnLnNldE92ZXJ3cml0ZU91dHB1dCh0cnVlKTsK' | base64 -d > /opt/remotion/remotion.config.ts

# embed /opt/remotion/src/index.ts
# import { registerRoot } from "remotion";
# import { RemotionRoot } from "./Root";
#
# registerRoot(RemotionRoot);
# end embed
RUN echo 'aW1wb3J0IHsgcmVnaXN0ZXJSb290IH0gZnJvbSAicmVtb3Rpb24iOwppbXBvcnQgeyBSZW1vdGlvblJvb3QgfSBmcm9tICIuL1Jvb3QiOwoKcmVnaXN0ZXJSb290KFJlbW90aW9uUm9vdCk7Cg==' | base64 -d > /opt/remotion/src/index.ts

# embed /opt/remotion/src/Root.tsx
# import { AbsoluteFill, Composition } from "remotion";
#
# export const Main = () => {
#   return (
#     <AbsoluteFill
#       style={{
#         backgroundColor: "#0f172a",
#         color: "#f8fafc",
#         fontFamily: "DejaVu Sans, sans-serif",
#         fontSize: 72,
#         justifyContent: "center",
#         alignItems: "center",
#       }}
#     >
#       Main
#     </AbsoluteFill>
#   );
# };
#
# export const RemotionRoot = () => {
#   return (
#     <Composition
#       id="Main"
#       component={Main}
#       durationInFrames={30}
#       fps={30}
#       width={1280}
#       height={720}
#     />
#   );
# };
# end embed
RUN echo 'aW1wb3J0IHsgQWJzb2x1dGVGaWxsLCBDb21wb3NpdGlvbiB9IGZyb20gInJlbW90aW9uIjsKCmV4cG9ydCBjb25zdCBNYWluID0gKCkgPT4gewogIHJldHVybiAoCiAgICA8QWJzb2x1dGVGaWxsCiAgICAgIHN0eWxlPXt7CiAgICAgICAgYmFja2dyb3VuZENvbG9yOiAiIzBmMTcyYSIsCiAgICAgICAgY29sb3I6ICIjZjhmYWZjIiwKICAgICAgICBmb250RmFtaWx5OiAiRGVqYVZ1IFNhbnMsIHNhbnMtc2VyaWYiLAogICAgICAgIGZvbnRTaXplOiA3MiwKICAgICAgICBqdXN0aWZ5Q29udGVudDogImNlbnRlciIsCiAgICAgICAgYWxpZ25JdGVtczogImNlbnRlciIsCiAgICAgIH19CiAgICA+CiAgICAgIE1haW4KICAgIDwvQWJzb2x1dGVGaWxsPgogICk7Cn07CgpleHBvcnQgY29uc3QgUmVtb3Rpb25Sb290ID0gKCkgPT4gewogIHJldHVybiAoCiAgICA8Q29tcG9zaXRpb24KICAgICAgaWQ9Ik1haW4iCiAgICAgIGNvbXBvbmVudD17TWFpbn0KICAgICAgZHVyYXRpb25JbkZyYW1lcz17MzB9CiAgICAgIGZwcz17MzB9CiAgICAgIHdpZHRoPXsxMjgwfQogICAgICBoZWlnaHQ9ezcyMH0KICAgIC8+CiAgKTsKfTsK' | base64 -d > /opt/remotion/src/Root.tsx

# Прогрев кэша rspack: повторный кадр в sandbox-selfcheck должен уложиться в 60 с.
WORKDIR /opt/remotion
RUN npx remotion still src/index.ts Main /tmp/image-still.jpeg --frame=0 --log=error \
    && rm -f /tmp/image-still.jpeg

# embed /usr/local/bin/sandbox-vcpu
# #!/bin/sh
# # Квота vCPU песочницы: cgroup v2 cpu.max, затем v1 cpu.cfs_quota_us, затем nproc.
# set -eu
#
# print_vcpu() {
#   quota=$1
#   period=$2
#   case "$quota" in
#     "" | max | -1 | *[!0-9]*) return 1 ;;
#   esac
#   case "$period" in
#     "" | *[!0-9]*) return 1 ;;
#   esac
#   if [ "$period" -eq 0 ]; then
#     return 1
#   fi
#   vcpu=$(((quota + period / 2) / period))
#   if [ "$vcpu" -lt 1 ]; then
#     return 1
#   fi
#   printf "%s\n" "$vcpu"
# }
#
# read_cpu_max() {
#   file=$1
#   quota=""
#   period=""
#   [ -r "$file" ] || return 1
#   IFS=" " read -r quota period < "$file" || return 1
#   print_vcpu "$quota" "$period"
# }
#
# if read_cpu_max /sys/fs/cgroup/cpu.max; then
#   exit 0
# fi
#
# if [ -r /proc/self/cgroup ]; then
#   rel=""
#   while IFS= read -r line; do
#     case "$line" in
#       0::*)
#         rel=${line#0::}
#         break
#         ;;
#     esac
#   done < /proc/self/cgroup
#   if [ -n "$rel" ] && read_cpu_max "/sys/fs/cgroup${rel}/cpu.max"; then
#     exit 0
#   fi
# fi
#
# v1_quota=""
# v1_period="100000"
# if [ -r /sys/fs/cgroup/cpu/cpu.cfs_quota_us ]; then
#   v1_quota=$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us)
#   if [ -r /sys/fs/cgroup/cpu/cpu.cfs_period_us ]; then
#     v1_period=$(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us)
#   fi
# elif [ -r /proc/self/cgroup ]; then
#   rel=""
#   while IFS= read -r line; do
#     rest=${line#*:}
#     controllers=${rest%%:*}
#     path=${rest#*:}
#     case ",$controllers," in
#       *,cpu,*)
#         rel=$path
#         break
#         ;;
#     esac
#   done < /proc/self/cgroup
#   if [ -n "$rel" ] && [ -r "/sys/fs/cgroup/cpu${rel}/cpu.cfs_quota_us" ]; then
#     v1_quota=$(cat "/sys/fs/cgroup/cpu${rel}/cpu.cfs_quota_us")
#     if [ -r "/sys/fs/cgroup/cpu${rel}/cpu.cfs_period_us" ]; then
#       v1_period=$(cat "/sys/fs/cgroup/cpu${rel}/cpu.cfs_period_us")
#     fi
#   fi
# fi
#
# if [ -n "$v1_quota" ] && print_vcpu "$v1_quota" "$v1_period"; then
#   exit 0
# fi
#
# nproc
# end embed
RUN echo 'IyEvYmluL3NoCiMg0JrQstC+0YLQsCB2Q1BVINC/0LXRgdC+0YfQvdC40YbRizogY2dyb3VwIHYyIGNwdS5tYXgsINC30LDRgtC10LwgdjEgY3B1LmNmc19xdW90YV91cywg0LfQsNGC0LXQvCBucHJvYy4Kc2V0IC1ldQoKcHJpbnRfdmNwdSgpIHsKICBxdW90YT0kMQogIHBlcmlvZD0kMgogIGNhc2UgIiRxdW90YSIgaW4KICAgICIiIHwgbWF4IHwgLTEgfCAqWyEwLTldKikgcmV0dXJuIDEgOzsKICBlc2FjCiAgY2FzZSAiJHBlcmlvZCIgaW4KICAgICIiIHwgKlshMC05XSopIHJldHVybiAxIDs7CiAgZXNhYwogIGlmIFsgIiRwZXJpb2QiIC1lcSAwIF07IHRoZW4KICAgIHJldHVybiAxCiAgZmkKICB2Y3B1PSQoKChxdW90YSArIHBlcmlvZCAvIDIpIC8gcGVyaW9kKSkKICBpZiBbICIkdmNwdSIgLWx0IDEgXTsgdGhlbgogICAgcmV0dXJuIDEKICBmaQogIHByaW50ZiAiJXNcbiIgIiR2Y3B1Igp9CgpyZWFkX2NwdV9tYXgoKSB7CiAgZmlsZT0kMQogIHF1b3RhPSIiCiAgcGVyaW9kPSIiCiAgWyAtciAiJGZpbGUiIF0gfHwgcmV0dXJuIDEKICBJRlM9IiAiIHJlYWQgLXIgcXVvdGEgcGVyaW9kIDwgIiRmaWxlIiB8fCByZXR1cm4gMQogIHByaW50X3ZjcHUgIiRxdW90YSIgIiRwZXJpb2QiCn0KCmlmIHJlYWRfY3B1X21heCAvc3lzL2ZzL2Nncm91cC9jcHUubWF4OyB0aGVuCiAgZXhpdCAwCmZpCgppZiBbIC1yIC9wcm9jL3NlbGYvY2dyb3VwIF07IHRoZW4KICByZWw9IiIKICB3aGlsZSBJRlM9IHJlYWQgLXIgbGluZTsgZG8KICAgIGNhc2UgIiRsaW5lIiBpbgogICAgICAwOjoqKQogICAgICAgIHJlbD0ke2xpbmUjMDo6fQogICAgICAgIGJyZWFrCiAgICAgICAgOzsKICAgIGVzYWMKICBkb25lIDwgL3Byb2Mvc2VsZi9jZ3JvdXAKICBpZiBbIC1uICIkcmVsIiBdICYmIHJlYWRfY3B1X21heCAiL3N5cy9mcy9jZ3JvdXAke3JlbH0vY3B1Lm1heCI7IHRoZW4KICAgIGV4aXQgMAogIGZpCmZpCgp2MV9xdW90YT0iIgp2MV9wZXJpb2Q9IjEwMDAwMCIKaWYgWyAtciAvc3lzL2ZzL2Nncm91cC9jcHUvY3B1LmNmc19xdW90YV91cyBdOyB0aGVuCiAgdjFfcXVvdGE9JChjYXQgL3N5cy9mcy9jZ3JvdXAvY3B1L2NwdS5jZnNfcXVvdGFfdXMpCiAgaWYgWyAtciAvc3lzL2ZzL2Nncm91cC9jcHUvY3B1LmNmc19wZXJpb2RfdXMgXTsgdGhlbgogICAgdjFfcGVyaW9kPSQoY2F0IC9zeXMvZnMvY2dyb3VwL2NwdS9jcHUuY2ZzX3BlcmlvZF91cykKICBmaQplbGlmIFsgLXIgL3Byb2Mvc2VsZi9jZ3JvdXAgXTsgdGhlbgogIHJlbD0iIgogIHdoaWxlIElGUz0gcmVhZCAtciBsaW5lOyBkbwogICAgcmVzdD0ke2xpbmUjKjp9CiAgICBjb250cm9sbGVycz0ke3Jlc3QlJToqfQogICAgcGF0aD0ke3Jlc3QjKjp9CiAgICBjYXNlICIsJGNvbnRyb2xsZXJzLCIgaW4KICAgICAgKixjcHUsKikKICAgICAgICByZWw9JHBhdGgKICAgICAgICBicmVhawogICAgICAgIDs7CiAgICBlc2FjCiAgZG9uZSA8IC9wcm9jL3NlbGYvY2dyb3VwCiAgaWYgWyAtbiAiJHJlbCIgXSAmJiBbIC1yICIvc3lzL2ZzL2Nncm91cC9jcHUke3JlbH0vY3B1LmNmc19xdW90YV91cyIgXTsgdGhlbgogICAgdjFfcXVvdGE9JChjYXQgIi9zeXMvZnMvY2dyb3VwL2NwdSR7cmVsfS9jcHUuY2ZzX3F1b3RhX3VzIikKICAgIGlmIFsgLXIgIi9zeXMvZnMvY2dyb3VwL2NwdSR7cmVsfS9jcHUuY2ZzX3BlcmlvZF91cyIgXTsgdGhlbgogICAgICB2MV9wZXJpb2Q9JChjYXQgIi9zeXMvZnMvY2dyb3VwL2NwdSR7cmVsfS9jcHUuY2ZzX3BlcmlvZF91cyIpCiAgICBmaQogIGZpCmZpCgppZiBbIC1uICIkdjFfcXVvdGEiIF0gJiYgcHJpbnRfdmNwdSAiJHYxX3F1b3RhIiAiJHYxX3BlcmlvZCI7IHRoZW4KICBleGl0IDAKZmkKCm5wcm9jCg==' | base64 -d > /usr/local/bin/sandbox-vcpu
RUN chmod +x /usr/local/bin/sandbox-vcpu

# embed /usr/local/bin/sandbox-selfcheck
# #!/bin/sh
# set -eu
#
# if [ "${SANDBOX_SELFCHECK_INNER:-}" != 1 ]; then
#   export SANDBOX_SELFCHECK_INNER=1
#   exec timeout 60 "$0"
# fi
#
# cd /opt/remotion
#
# node_version=$(node --version)
# printf "node %s\n" "$node_version"
# printf "%s\n" "$node_version" | grep -q "^v24\."
#
# python3 --version
#
# npx remotion versions
#
# browser=""
# for candidate in \
#   node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/headless_shell \
#   node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/chrome-headless-shell \
#   node_modules/.remotion/chrome-headless-shell/linux-arm64/chrome-headless-shell-linux-arm64/headless_shell \
#   node_modules/.remotion/chrome-headless-shell/linux-arm64/chrome-headless-shell-linux-arm64/chrome-headless-shell
# do
#   if [ -f "$candidate" ]; then
#     browser=$candidate
#     break
#   fi
# done
#
# if [ -z "$browser" ]; then
#   echo "Headless Shell не найден" >&2
#   exit 1
# fi
#
# printf "browser %s\n" "$browser"
# "$browser" --no-sandbox --disable-gpu --version
#
# if ! fc-list :lang=ru | grep -q .; then
#   echo "Русский шрифт не найден" >&2
#   exit 1
# fi
# echo "font ru ok"
#
# printf "vcpu %s\n" "$(sandbox-vcpu)"
#
# if [ -r /sys/fs/cgroup/memory.max ]; then
#   printf "memory.max %s\n" "$(cat /sys/fs/cgroup/memory.max)"
# elif [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
#   printf "memory.limit_in_bytes %s\n" "$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes)"
# else
#   echo "Память cgroup не найдена" >&2
#   exit 1
# fi
#
# npx remotion still src/index.ts Main /tmp/sandbox-selfcheck.jpeg --frame=0 --log=error
# test -s /tmp/sandbox-selfcheck.jpeg
# echo "frame ok"
# end embed
RUN echo 'IyEvYmluL3NoCnNldCAtZXUKCmlmIFsgIiR7U0FOREJPWF9TRUxGQ0hFQ0tfSU5ORVI6LX0iICE9IDEgXTsgdGhlbgogIGV4cG9ydCBTQU5EQk9YX1NFTEZDSEVDS19JTk5FUj0xCiAgZXhlYyB0aW1lb3V0IDYwICIkMCIKZmkKCmNkIC9vcHQvcmVtb3Rpb24KCm5vZGVfdmVyc2lvbj0kKG5vZGUgLS12ZXJzaW9uKQpwcmludGYgIm5vZGUgJXNcbiIgIiRub2RlX3ZlcnNpb24iCnByaW50ZiAiJXNcbiIgIiRub2RlX3ZlcnNpb24iIHwgZ3JlcCAtcSAiXnYyNFwuIgoKcHl0aG9uMyAtLXZlcnNpb24KCm5weCByZW1vdGlvbiB2ZXJzaW9ucwoKYnJvd3Nlcj0iIgpmb3IgY2FuZGlkYXRlIGluIFwKICBub2RlX21vZHVsZXMvLnJlbW90aW9uL2Nocm9tZS1oZWFkbGVzcy1zaGVsbC9saW51eDY0L2Nocm9tZS1oZWFkbGVzcy1zaGVsbC1saW51eDY0L2hlYWRsZXNzX3NoZWxsIFwKICBub2RlX21vZHVsZXMvLnJlbW90aW9uL2Nocm9tZS1oZWFkbGVzcy1zaGVsbC9saW51eDY0L2Nocm9tZS1oZWFkbGVzcy1zaGVsbC1saW51eDY0L2Nocm9tZS1oZWFkbGVzcy1zaGVsbCBcCiAgbm9kZV9tb2R1bGVzLy5yZW1vdGlvbi9jaHJvbWUtaGVhZGxlc3Mtc2hlbGwvbGludXgtYXJtNjQvY2hyb21lLWhlYWRsZXNzLXNoZWxsLWxpbnV4LWFybTY0L2hlYWRsZXNzX3NoZWxsIFwKICBub2RlX21vZHVsZXMvLnJlbW90aW9uL2Nocm9tZS1oZWFkbGVzcy1zaGVsbC9saW51eC1hcm02NC9jaHJvbWUtaGVhZGxlc3Mtc2hlbGwtbGludXgtYXJtNjQvY2hyb21lLWhlYWRsZXNzLXNoZWxsCmRvCiAgaWYgWyAtZiAiJGNhbmRpZGF0ZSIgXTsgdGhlbgogICAgYnJvd3Nlcj0kY2FuZGlkYXRlCiAgICBicmVhawogIGZpCmRvbmUKCmlmIFsgLXogIiRicm93c2VyIiBdOyB0aGVuCiAgZWNobyAiSGVhZGxlc3MgU2hlbGwg0L3QtSDQvdCw0LnQtNC10L0iID4mMgogIGV4aXQgMQpmaQoKcHJpbnRmICJicm93c2VyICVzXG4iICIkYnJvd3NlciIKIiRicm93c2VyIiAtLW5vLXNhbmRib3ggLS1kaXNhYmxlLWdwdSAtLXZlcnNpb24KCmlmICEgZmMtbGlzdCA6bGFuZz1ydSB8IGdyZXAgLXEgLjsgdGhlbgogIGVjaG8gItCg0YPRgdGB0LrQuNC5INGI0YDQuNGE0YIg0L3QtSDQvdCw0LnQtNC10L0iID4mMgogIGV4aXQgMQpmaQplY2hvICJmb250IHJ1IG9rIgoKcHJpbnRmICJ2Y3B1ICVzXG4iICIkKHNhbmRib3gtdmNwdSkiCgppZiBbIC1yIC9zeXMvZnMvY2dyb3VwL21lbW9yeS5tYXggXTsgdGhlbgogIHByaW50ZiAibWVtb3J5Lm1heCAlc1xuIiAiJChjYXQgL3N5cy9mcy9jZ3JvdXAvbWVtb3J5Lm1heCkiCmVsaWYgWyAtciAvc3lzL2ZzL2Nncm91cC9tZW1vcnkvbWVtb3J5LmxpbWl0X2luX2J5dGVzIF07IHRoZW4KICBwcmludGYgIm1lbW9yeS5saW1pdF9pbl9ieXRlcyAlc1xuIiAiJChjYXQgL3N5cy9mcy9jZ3JvdXAvbWVtb3J5L21lbW9yeS5saW1pdF9pbl9ieXRlcykiCmVsc2UKICBlY2hvICLQn9Cw0LzRj9GC0YwgY2dyb3VwINC90LUg0L3QsNC50LTQtdC90LAiID4mMgogIGV4aXQgMQpmaQoKbnB4IHJlbW90aW9uIHN0aWxsIHNyYy9pbmRleC50cyBNYWluIC90bXAvc2FuZGJveC1zZWxmY2hlY2suanBlZyAtLWZyYW1lPTAgLS1sb2c9ZXJyb3IKdGVzdCAtcyAvdG1wL3NhbmRib3gtc2VsZmNoZWNrLmpwZWcKZWNobyAiZnJhbWUgb2siCg==' | base64 -d > /usr/local/bin/sandbox-selfcheck
RUN chmod +x /usr/local/bin/sandbox-selfcheck

RUN python3 -m pip install --no-cache-dir "Pillow==13.0.0"

RUN mkdir -p /workspace && chmod 0777 /workspace
WORKDIR /workspace
