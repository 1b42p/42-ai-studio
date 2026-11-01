import { defineSandbox } from "eve/sandbox";
import { DaytonaSandbox } from "../lib/daytona-provider";

export const environment = DaytonaSandbox.environment();
export default defineSandbox(() => environment.open());
