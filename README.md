# ainz

A microservice which moves (actually just makes links) resources from a "watch list" to another list based on rules.

`ainz` is the core orchestrator service for Trellis, generally used to put things into service jobs queues
when a change matches a pre-defined rule.

See [rule.example.json5](rule.example.json5) for an annotated example of a rule.

Rules are located at `/bookmarks/services/ainz/rules` by default (but this can be changed via config).

## Installation
```bash
cd /path/to/your/oada-srvc-docker
cd services-available
git clone git@github.com:trellisfw/ainz.git
cd ../services-enabled
ln -s ../services-available/ainz .
```

## Overriding defaults for production
Using similar `z_tokens` method described in `oada`, the following docker-compose entries
are useful for production `ainz` deployments:
```docker-compose
  ainz:
    environment:
      - token=atokentouseinproduction
      - domain=your.trellis.domain
```
