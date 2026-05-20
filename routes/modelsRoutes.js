import { Router } from "express";

import { allowedModelIds } from "../modelRegistry.js";

export const modelsRouter = Router();

modelsRouter.get("/models", (req, res) => {
  res.json({
    object: "list",
    data: allowedModelIds.map((id) => ({
      id,
      object: "model"
    }))
  });
});
