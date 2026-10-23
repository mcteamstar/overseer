FROM node:22-slim

# Install Tailscale
RUN apt-get update && \
    apt-get install -y curl iptables iproute2 && \
    curl -fsSL https://tailscale.com/install.sh | sh && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy agent code and config
# moderation.config.local.yaml (gitignored) is the production config with
# domain-specific examples. moderation.config.yaml is the public template.
# The build script uses local if present; falls back to template.
COPY dist/main.js ./
COPY moderation.config*.yaml ./
RUN if [ -f moderation.config.local.yaml ]; then \
      mv moderation.config.local.yaml moderation.config.yaml; \
    fi

# Startup script
COPY start.sh ./
RUN chmod +x start.sh

EXPOSE 8080

CMD ["./start.sh"]
