// @vitest-environment jsdom
import {afterEach, expect, it} from "vitest";
import {displayName, maskPrivateName} from "./lib/display-name";
import {setTheme} from "./lib/theme";
afterEach(()=>setTheme("daylight"));
it("masks case-insensitive substrings with exactly four stars",()=>{
 expect(maskPrivateName("CUPSHE / GongQianKun / caGUuu project")).toBe("c****e / g****n / c****u project");
 expect(maskPrivateName("/Users/gongqiankun/Cupshe-seo")).toBe("/Users/g****n/c****e-seo");
});
it("only changes presentation in Buzhoushan",()=>{
 const canonical="CUPSHE project";
 setTheme("buzhoushan");expect(displayName(canonical)).toBe("c****e project");
 setTheme("official");expect(displayName(canonical)).toBe(canonical);
 expect(displayName(undefined)).toBe("");
});
