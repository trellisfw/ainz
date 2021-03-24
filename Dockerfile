ARG NODE_VER=14-buster

FROM node:$NODE_VER AS install

WORKDIR /trellis/ainz

COPY ./package.json ./yarn.lock /trellis/ainz/

RUN yarn install --production --immutable

FROM install AS build

COPY . /trellis/ainz/

RUN yarn install --immutable

RUN yarn build && rm -rf node_modules

FROM node:$NODE_VER-slim AS production

WORKDIR /trellis/ainz

COPY --from=install /trellis/ainz/ /trellis/ainz/
COPY --from=build /trellis/ainz/ /trellis/ainz/

ENTRYPOINT ["yarn", "run"]
CMD ["start"]
