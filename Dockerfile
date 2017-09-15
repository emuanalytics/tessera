# Mapnik requires GLIBCXX_3.4.21, which is not available on standard Jessie deb build for Docker node image
# so build from scratch
FROM debian:stretch

RUN apt-get -qq update \
&& DEBIAN_FRONTEND=noninteractive apt-get -y install \
    apt-transport-https \
    curl \
    unzip \
    build-essential \
    git-core \
&& echo "deb https://deb.nodesource.com/node_6.x jessie main" >> /etc/apt/sources.list.d/nodejs.list \
&& echo "deb-src https://deb.nodesource.com/node_6.x jessie main" >> /etc/apt/sources.list.d/nodejs.list \
&& apt-get -qq update \
&& DEBIAN_FRONTEND=noninteractive apt-get -y --allow-unauthenticated install \
    nodejs \
&& rm /etc/apt/sources.list.d/nodejs.list \
&& apt-get clean

WORKDIR /usr/src/app

COPY package.json bower.json .bowerrc ./

RUN npm install --unsafe-perm

# Install tilelive modules
RUN npm install mbtiles tilelive-vector tilelive-xray

# Install customised Emu variants
RUN npm install git+https://github.com/emuanalytics/tilelive-modules.git#b51e280 git+https://github.com/emuanalytics/tilelive-postgis.git#ae2bbda2

RUN mkdir /data
RUN mkdir /config

COPY . .

VOLUME /config
VOLUME /data

EXPOSE 8080

ENTRYPOINT ["./bin/tessera.js"]
CMD ["-c", "/config"]