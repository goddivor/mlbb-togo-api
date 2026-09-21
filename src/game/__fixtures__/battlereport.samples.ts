// Battle report payload samples: the examples of Rone Arena's OpenAPI
// (api-research/arena-openapi.json), which relays Moonton's JSON unchanged,
// plus the observed error bodies (invalid token, decommissioned route).
// Note: `bid` numbers are already rounded by JSON.parse, `bid_s` is exact.
/* eslint-disable */
export const samples: Record<string, any> = {
  "stats": {
    "code": 0,
    "message": "Success",
    "traceID": "b506b47e790797eb1f9762d2f1586496",
    "data": {
      "wc": 188,
      "tc": 308,
      "as": 762.3552,
      "gt": 77.95,
      "mvpc": 73,
      "wsc": 11,
      "mo": {
        "v": 112848,
        "ts": 1726010389,
        "hid": 36,
        "bid": 4110381620662451700,
        "sid": 0,
        "hid_e": {
          "id": 36,
          "n": "Aurora",
          "ix": "https://akmweb.youngjoygame.com/web/gms/image/ed2295c60bd772b89b7bdbbc2aee6095.png",
          "i2x": "https://akmweb.youngjoygame.com/web/svnres/file/mlbb/homepage/100_58b97db6a5c286059057d42289612b16.jpg"
        },
        "bid_s": "4110381620662451526"
      },
      "hk": {
        "v": 25,
        "ts": 1672500616,
        "hid": 84,
        "bid": 4108435467847910000,
        "sid": 0,
        "hid_e": {
          "id": 84,
          "n": "Ling",
          "ix": "https://akmweb.youngjoygame.com/web/svnres/img/mlbb/community/100_af4312bae7aa443129b46a17b4dce3a6.png",
          "i2x": "https://akmweb.youngjoygame.com/web/svnres/file/mlbb/homepage/100_f76a7dfe805afa316e5ec44295b75772.jpg"
        },
        "bid_s": "4108435467847910024"
      },
      "ma": {
        "v": 31,
        "ts": 1725653347,
        "hid": 20,
        "bid": 4109721990994840000,
        "sid": 0,
        "hid_e": {
          "id": 20,
          "n": "Lolita",
          "ix": "https://akmweb.youngjoygame.com/web/gms/image/ce1c7af1a946f70585e40296ba85c9c0.jpg",
          "i2x": "https://akmweb.youngjoygame.com/web/svnres/file/mlbb/homepage/100_1bc4973e512cf4958fe639e12391666e.jpg"
        },
        "bid_s": "4109721990994840266"
      },
      "ms": {
        "v": 1330,
        "ts": 1715555863,
        "hid": 84,
        "bid": 4110821683001146000,
        "sid": 0,
        "hid_e": {
          "id": 84,
          "n": "Ling",
          "ix": "https://akmweb.youngjoygame.com/web/svnres/img/mlbb/community/100_af4312bae7aa443129b46a17b4dce3a6.png",
          "i2x": "https://akmweb.youngjoygame.com/web/svnres/file/mlbb/homepage/100_f76a7dfe805afa316e5ec44295b75772.jpg"
        },
        "bid_s": "4110821683001146109"
      },
      "mdt": {
        "v": 372063,
        "ts": 1727227888,
        "hid": 20,
        "bid": 4109978035471765500,
        "sid": 0,
        "hid_e": {
          "id": 20,
          "n": "Lolita",
          "ix": "https://akmweb.youngjoygame.com/web/gms/image/ce1c7af1a946f70585e40296ba85c9c0.jpg",
          "i2x": "https://akmweb.youngjoygame.com/web/svnres/file/mlbb/homepage/100_1bc4973e512cf4958fe639e12391666e.jpg"
        },
        "bid_s": "4109978035471765660"
      },
      "mg": {
        "v": 22282,
        "ts": 1718939040,
        "hid": 84,
        "bid": 4116060748536699000,
        "sid": 0,
        "hid_e": {
          "id": 84,
          "n": "Ling",
          "ix": "https://akmweb.youngjoygame.com/web/svnres/img/mlbb/community/100_af4312bae7aa443129b46a17b4dce3a6.png",
          "i2x": "https://akmweb.youngjoygame.com/web/svnres/file/mlbb/homepage/100_f76a7dfe805afa316e5ec44295b75772.jpg"
        },
        "bid_s": "4116060748536698631"
      },
      "mtd": {
        "v": 27152,
        "ts": 1719290587,
        "hid": 65,
        "bid": 4110233968270030300,
        "sid": 0,
        "hid_e": {
          "id": 65,
          "n": "Claude",
          "ix": "https://akmweb.youngjoygame.com/web/svnres/img/mlbb/community/100_7ed528f154dd4f460c59361ab0ed7942.png",
          "i2x": "https://akmweb.youngjoygame.com/web/svnres/file/mlbb/homepage/100_1edf19b0839ffd2bffb60b4ee4953239.jpg"
        },
        "bid_s": "4110233968270030438"
      },
      "sids": [
        40,
        39,
        38,
        37
      ]
    }
  },
  "season": {
    "code": 0,
    "message": "Success",
    "traceID": "74879d32961c1784a762671398979ac6",
    "data": {
      "sids": [
        40,
        39,
        38,
        37
      ]
    }
  },
  "matches": {
    "code": 0,
    "message": "Success",
    "traceID": "53cd62802d24dc512ffd908e1d6d06bc",
    "data": {
      "pageInfo": {
        "nextCursor": "4143043017340290910",
        "hasNext": true,
        "count": 1
      },
      "result": [
        {
          "sid": 40,
          "bid": 4132717739868068400,
          "hid": 17,
          "k": 14,
          "d": 1,
          "a": 11,
          "lid": 4,
          "s": 1180,
          "mvp": 0,
          "res": 1,
          "ts": 1774857999,
          "hid_e": {
            "id": 17,
            "n": "Fanny",
            "ix": "https://akmweb.youngjoygame.com/web/svnres/img/mlbb/community/100_ae8ca46da01da69619a6c03dc7069921.png",
            "i2x": "https://akmweb.youngjoygame.com/web/svnres/file/mlbb/homepage/100_74fabc6c0d5db065fbb836b6879f36ca.jpg"
          },
          "bid_s": "4132717739868068534"
        }
      ]
    }
  },
  "matchDetail": {
    "code": 0,
    "message": "Success",
    "traceID": "4d96357b092ade76774481366567bcaf",
    "data": {
      "result": [
        {
          "f": 2,
          "hid": 31,
          "rid": 1880233572,
          "zid": 57027,
          "k": 4,
          "d": 9,
          "a": 6,
          "tfr": 0.4167,
          "o": 83974,
          "op": 0.2202,
          "s": 509,
          "mvp": 0,
          "its": [
            2305,
            3002,
            3005,
            3015,
            3003,
            3013,
            0
          ],
          "eq": 0,
          "ts": 1773837471,
          "bd": 1292,
          "fk": 24,
          "fw": 0,
          "hid_e": {
            "id": 31,
            "n": "Moskov",
            "ix": "https://akmweb.youngjoygame.com/web/gms/image/5c4587c25e681be1aecfda0cfbe44714.png",
            "i2x": "https://akmweb.youngjoygame.com/web/svnres/file/mlbb/homepage/100_843f1c2c3a1b2d4da2fc2ec73cf47cfa.jpg"
          },
          "its_e": [
            {
              "id": 2305,
              "n": "Swift Boots",
              "ix": "https://akmweb.youngjoygame.com/web/svnres/img/mlbb/homepage/100_b31a355cc85682eed8d9e0dc163fd756.png",
              "i2x": ""
            },
            null
          ],
          "hlvl": 15,
          "rname": "ᴵᵐŦungiℓ"
        }
      ]
    }
  },
  "frequent": {
    "code": 0,
    "message": "Success",
    "traceID": "6b098c3c683f977217a91bb6c630e7be",
    "data": {
      "pageInfo": {
        "nextCursor": "",
        "hasNext": true,
        "count": 0
      },
      "result": [
        {
          "hid": 17,
          "tc": 8,
          "wc": 7,
          "bs": 844.875,
          "mr": 6626,
          "mrp": 0.6188,
          "hid_e": {
            "id": 17,
            "n": "Fanny",
            "ix": "https://akmweb.youngjoygame.com/web/svnres/img/mlbb/community/100_ae8ca46da01da69619a6c03dc7069921.png",
            "i2x": "https://akmweb.youngjoygame.com/web/svnres/file/mlbb/homepage/100_74fabc6c0d5db065fbb836b6879f36ca.jpg"
          },
          "p": 1460
        }
      ]
    }
  },
  "heroMatches": {
    "code": 0,
    "message": "Success",
    "traceID": "15b79802139dd7766774f6e84ffc31bd",
    "data": {
      "pageInfo": {
        "nextCursor": "",
        "hasNext": false,
        "count": 0
      },
      "hi": {
        "hid": 17,
        "tc": 9,
        "wc": 8,
        "bs": 0,
        "mr": 6788,
        "mrp": 0.6641,
        "hid_e": {
          "id": 17,
          "n": "Fanny",
          "ix": "https://akmweb.youngjoygame.com/web/svnres/img/mlbb/community/100_ae8ca46da01da69619a6c03dc7069921.png",
          "i2x": "https://akmweb.youngjoygame.com/web/svnres/file/mlbb/homepage/100_74fabc6c0d5db065fbb836b6879f36ca.jpg"
        },
        "p": 1496
      },
      "result": [
        {
          "sid": 40,
          "bid": 4138442308503475824,
          "hid": 17,
          "k": 7,
          "d": 3,
          "a": 7,
          "lid": 4,
          "s": 810,
          "mvp": 0,
          "res": 1,
          "ts": 1774955310,
          "hid_e": {
            "id": 17,
            "n": "Fanny",
            "ix": "https://akmweb.youngjoygame.com/web/svnres/img/mlbb/community/100_ae8ca46da01da69619a6c03dc7069921.png",
            "i2x": "https://akmweb.youngjoygame.com/web/svnres/file/mlbb/homepage/100_74fabc6c0d5db065fbb836b6879f36ca.jpg"
          },
          "bid_s": "4138442308503475824"
        }
      ]
    }
  },
  "info": {
    "code": 0,
    "data": {
      "avatar": "https://akmpicture.youngjoygame.com/dist/face/57060/66/96/1149309666_26_new_9ced56d6-3625-48c3-85d1-0b862a2044e7.jpg",
      "history_rank_level": 9999,
      "level": 200,
      "name": "SAYA AKAN LAWAN",
      "rank_level": 8000,
      "reg_country": "ID",
      "roleId": 1234567890,
      "zoneId": 123456
    },
    "msg": "ok"
  },
  "invalidToken": {
    "code": 1002,
    "data": null,
    "msg": null,
    "message": "auth is empty",
    "traceID": "aa09ad9363c96bdd2924eeeda3d5b7a9"
  },
  "offline": {
    "code": 10407,
    "message": "接口下线",
    "data": null
  }
};
