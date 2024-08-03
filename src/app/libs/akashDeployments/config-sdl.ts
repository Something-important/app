// config-sdl.js
export const sdlContent = `
version: "2.0"
services:
  dail:
    image: thelogicalguy/backend
    expose:
      - port: 3001
        as: 3001
        to:
          - global: true
profiles:
  compute:
    dail:
      resources:
        cpu:
          units: 0.2
        memory:
          size: 1GB
        storage:
          - size: 1Gi
  placement:
    dcloud:
      pricing:
        dail:
          denom: uakt
          amount: 1000
deployment:
  dail:
    dcloud:
      profile: dail
      count: 1
`;