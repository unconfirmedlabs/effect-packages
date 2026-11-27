/** Deterministic zkLogin fixtures (a made-up JWT and proof inputs that parse but prove nothing). */
const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url")

export const header = { alg: "RS256", kid: "a50f6e70ef4b548a5fd9142eecd1fb8f54dce9ee", typ: "JWT" }

export const makeJwt = (claims: Record<string, unknown>) =>
  `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}.c2lnbmF0dXJl`

export const claims = {
  iss: "https://accounts.google.com",
  azp: "573120070871-0k7ga6ns79ie0jpg1ei6ip5vje2ostt6.apps.googleusercontent.com",
  aud: "573120070871-0k7ga6ns79ie0jpg1ei6ip5vje2ostt6.apps.googleusercontent.com",
  sub: "110463452167303598383",
  nonce: "hTPpgF7XAKbW37rEUS6pEVZqmoI",
  nbf: 1700000000,
  iat: 1700000300,
  exp: 1700003900,
  jti: "e5b2a2f9e6d1c0f2b3a4"
}

export const jwt = makeJwt(claims)

/** `issBase64Details` as a prover reports it: the claim's base64url slice of the payload and its offset mod 4. */
export const claimDetails = (token: string, name: string) => {
  const payload = token.split(".")[1]!
  const json = Buffer.from(payload, "base64url").toString("utf8")
  const key = `"${name}":`
  const start = json.indexOf(key)
  let end = json.indexOf(",", start) + 1 // claim + its trailing ','
  if (end === 0) end = json.indexOf("}", start) + 1
  const startByte = Buffer.byteLength(json.slice(0, start))
  const endByte = Buffer.byteLength(json.slice(0, end))
  const startChar = Math.floor((startByte * 4) / 3)
  const endChar = Math.ceil((endByte * 4) / 3)
  return { value: payload.slice(startChar, endChar), indexMod4: startChar % 4 }
}

export const inputs = (addressSeed: string, kid = header.kid) => ({
  proofPoints: {
    a: [
      "17267520948013237176538401967633949796808964318007586959472021003187557716854",
      "14650660244262428784196747165683760208919070184766586754097510948934669736103",
      "1"
    ],
    b: [
      [
        "21139310988334827550539224708307701217878230950292201561482099688321320348443",
        "10547097602625638823059992458926868829066244356588080322181801706465994418281"
      ],
      [
        "12744153306027049365027606189549081708414309055722206371798414155740784907883",
        "17883388059920040098415197241200663975335711492591606641576557652282627716838"
      ],
      ["1", "0"]
    ],
    c: [
      "14769767061575837119226231519343805418804298487906870764117230269550212315249",
      "19108054814174425469923382354535700312637807408963428646825944966509611405530",
      "1"
    ]
  },
  issBase64Details: claimDetails(jwt, "iss"),
  headerBase64: Buffer.from(JSON.stringify({ ...header, kid })).toString("base64url"),
  addressSeed
})
