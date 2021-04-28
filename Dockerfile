ARG NODE_VER=16-alpine

FROM node:$NODE_VER AS install

WORKDIR /trellis/ainz

COPY ./.yarn /trellis/ainz/.yarn
COPY ./package.json ./yarn.lock ./.yarnrc.yml /trellis/ainz/

RUN yarn workspaces focus --all --production

FROM install AS build

# Install dev deps too
RUN yarn install --immutable

COPY . /trellis/ainz/

# Build code and remove dev deps
RUN yarn build && rm -rfv .yarn .pnp*

FROM node:$NODE_VER AS production

# Do not run service as root
USER node

WORKDIR /trellis/ainz

COPY --from=install /trellis/ainz/ /trellis/ainz/
COPY --from=build /trellis/ainz/ /trellis/ainz/

ENTRYPOINT ["yarn", "run"]
CMD ["start"]
