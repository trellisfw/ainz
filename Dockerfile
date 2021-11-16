# Copyright 2021 Qlever LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

ARG NODE_VER=16-alpine
ARG SERVICE=trellisfw/ainz

FROM node:$NODE_VER AS install
ARG SERVICE

WORKDIR /$SERVICE

COPY ./.yarn /$SERVICE/.yarn
COPY ./package.json ./yarn.lock ./.yarnrc.yml /$SERVICE/

RUN yarn workspaces focus --all --production

FROM install AS build
ARG SERVICE

# Install dev deps too
RUN yarn install --immutable

COPY . /$SERVICE/

# Build code and remove dev deps
RUN yarn build --verbose && rm -rfv .yarn .pnp*

FROM node:$NODE_VER AS production
ARG SERVICE

# Install needed packages
RUN apk add --no-cache \
    dumb-init

# Do not run service as root
USER node

WORKDIR /$SERVICE

COPY --from=install /$SERVICE/ /$SERVICE/
COPY --from=build /$SERVICE/ /$SERVICE/

# Launch entrypoint with dumb-init
# Remap SIGTERM to SIGINT https://github.com/Yelp/dumb-init#signal-rewriting
ENTRYPOINT ["/usr/bin/dumb-init", "--rewrite", "15:2", "--", "yarn", "run"]
CMD ["start"]
