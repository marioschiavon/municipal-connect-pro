import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const Input = z.object({
  municipio: z.string().min(1),
  uf: z.string().length(2),
});

export const prospectarMunicipio = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => Input.parse(data))
  .handler(async ({ data }) => {
    const { prospectar } = await import("./prospect.server");
    return prospectar(data.municipio, data.uf);
  });
