import { handler } from "./index.mjs";

handler()
  .then((res) => console.log("Success:", res))
  .catch((err) => console.error("Error:", err));
