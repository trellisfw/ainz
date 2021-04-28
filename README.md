[![License](https://img.shields.io/github/license/trellisfw/ainz)](LICENSE)
[![Docker Pulls](https://img.shields.io/docker/pulls/trellisfw/ainz)][dockerhub]

# Ainz

This is a microservice which moves (actually just makes links)
resources from a "watch list" to another list based on rules.

## Usage

Eventually Ainz images should be pushed to dockerhub,
but for now you can run Ainz by cloning this repo.

### docker-compose

Here is an example of using ainz with docker-compose.

```yaml
services:
  ainz:
    image: trellisfw/ainz
    restart: unless-stopped
    #volumes:
    # Additional template helpers can be mapped into the helpers dir.
    # Ainz will load all helpers it finds at boot.
    #- ./path/to/helper-module:/trellis/ainz/dist/helpers/helper-module
    environment:
      NODE_TLS_REJECT_UNAUTHORIZED:
      NODE_ENV=: ${NODE_ENV:-development}
      DEBUG: ${DEBUG-*:error,*:warn,*:info}
      # Connect to host if DOMAIN not set.
      # You should really not rely on this though. Set DOMAIN.
      domain: ${DOMAIN:-host.docker.internal}
      # Unless your API server is running with development tokens enabled,
      # you will need to give Ainz token(s) to use.
      token: ${AINZ_TOKENS:-abc123,def456}
```

### Running ainz within the [OADA Reference API Server]

To add Ainz to the services run with an OADA v3 server,
simply add a snippet like the one in the previous section
to your `docker-compose.override.yml`.

### External Usage

To run Ainz separately, simply set the domain and token(s) of the OADA API.

```shell
# Set up the environment.
# Only need to run these the first time.
echo DOMAIN=api.oada.example.com > .env # Set API domain
echo AINZ_TOKENS=abc123,def456 >> .env # Set API token(s) for Ainz

# Start Ainz
docker-compose up -d
```

## Rules Format

See [rule.example.json5](rule.example.json5) for an annotated example of a rule.

You can also see the corresponsing [schemas] from OADA formats.

A user's rules are located at `/bookmarks/services/ainz/rules` by default.

[dockerhub]: https://hub.docker.com/repository/docker/trellisfw/ainz
[oada reference api server]: https://github.com/OADA/oada-srvc-docker
[schemas]: https://github.com/OADA/formats/tree/master/schemas/oada/ainz
