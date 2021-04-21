ARG NODE_VER=14-buster

FROM node:$NODE_VER AS install

WORKDIR /trellis/ainz

COPY ./.yarn /trellis/ainz/.yarn
COPY ./package.json ./yarn.lock ./.yarnrc.yml /trellis/ainz/

RUN yarn workspaces focus --all --production

FROM install AS build

# Install dev deps too
RUN yarn install --immutable

COPY . /trellis/ainz/

RUN yarn build && rm -rf node_modules

FROM node:$NODE_VER-slim AS production

WORKDIR /trellis/ainz

COPY --from=install /trellis/ainz/ /trellis/ainz/
COPY --from=build /trellis/ainz/ /trellis/ainz/

ENTRYPOINT ["yarn", "run"]
CMD ["start"]
