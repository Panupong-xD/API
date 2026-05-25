import { Router } from "express";

import { allowedModelIds } from "../modelRegistry.js";

export const modelsRouter = Router();

modelsRouter.get("/models", (req, res) => {
  return res.status(200).json({
    object: "list",
    data: allowedModelIds.map((id) => ({
      id,
      object: "model"
    }))
  });
});
