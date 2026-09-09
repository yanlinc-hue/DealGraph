import type { RelationKind, RelationshipCase } from './types.ts';

export const COMMERCIAL_SCOPE_PROMPT = `BUSINESS RELATIONS ONLY. Extract business employment, decision mandates, equity/investment, corporate financing, M&A, advisory mandates, business project roles, executed commercial cooperation, or completed BUSINESS introductions. Ignore greetings, meals, travel, hobbies, gaming, romance, kinship, friendships, ordinary acquaintance, group membership, message frequency, personal favors and consumer/personal loans. An employee/client talking about family does not make that family member a business node. A social introduction at dinner is NOT a business introduction; require an explicit business purpose or mandate in its own assertion. Personal loans, meal money and red packets are not corporate financing. Merely mentioning a company nearby is not business evidence. A dinner arranged for an explicitly completed financing introduction may qualify for the introduction, never for a fabricated cooperation. Do not infer decision power, financial capacity, kinship control, influence or trust from social familiarity.`;

const BUSINESS = /任职|担任|董事|首席|总经理|财务顾问|法律顾问|合伙人|投资|持股|股权|融资|收购|并购|贷款|授信|公司|集团|银行|企业|资本|基金|科技|产业|设备|项目|审批权|决策权|供应|采购|订单|商务|业务|业务合作|战略合作|合作协议|研发|供应商|客户|\b(?:company|corporate|investment|equity|financing|acquisition|advisory|business|project|supplier|procurement|director|officer)\b/iu;
const PERSONAL = /饭钱|餐费|红包|压岁钱|零花钱|生活费|彩礼|个人贷款|消费贷|装修(?:自家|自己|住房)|自家住房|个人房贷|借.{0,8}(?:买菜|吃饭|旅游|打车)|(?:游戏|打球|麻将|钓鱼|组队|做饭).{0,8}合作|相亲|男朋友|女朋友|恋爱|闺蜜|介绍.{0,12}(?:认识|交个朋友).{0,8}(?:而已|就好)|\b(?:dating|pocket money|lunch money|personal loan)\b/iu;
const ASSERTION = /担任|任职|出任|董事长|首席|总经理|负责|合伙人|财务顾问|法律顾问|审批权|决策权|投资|持有|持股|(?:发放|提供)(?:的)?贷款|授信|收购|并购|子公司|签.{0,8}(?:合作|协议|合同)|联合研发|采购|供应|引荐|介绍|牵线|\b(?:appointed|serves as|director|invested|owns|acquired|lends|introduced)\b/iu;
const DAILY = /上小学|上学|放学|接孩子|接娃|等妈妈|等爸爸|陪孩子|带孩子|女儿|儿子|老婆|老公|妻子|丈夫|亲戚|父亲|母亲|朋友|吃饭|聚餐|旅游|露营|球拍|下棋|钓鱼/u;
const BUSINESS_PURPOSE = /(?:为了?|推进|促成|推动|对接|针对|围绕|用于|服务于|已就)[^，,。；;]{0,30}(?:融资|投资|商务|业务|并购|交易|合作|采购|客户|供应|项目|订单)|(?:融资|投资|商务|业务|并购|交易|合作|采购|客户|供应|项目|订单)[】\s]*(?:这边|方面|事宜)|(?:商务|业务)(?:引荐|介绍|对接)|\b(?:for|regarding|to discuss)\b[^.;]{0,40}\b(?:business|financing|investment|project|procurement)\b/iu;

export function businessNodeAllowed(name: string, quote: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ownRole = new RegExp(`${escaped}(?:目前|现在|已|正式|现|是|为|\\s){0,8}(?:担任|任职|出任|投资了|持有|拥有|负责|是.{0,30}(?:董事|总经理|首席|负责人))|(?:董事长|总经理|首席财务官|负责人|合伙人)\\s*${escaped}`, 'u');
  return quote.split(/[。；;!?！？\n]/u).some(clause => {
    if (!clause.includes(name) || !hasBusinessContext(clause) || !ASSERTION.test(clause.replaceAll(name, '【候选】'))) return false;
    if (DAILY.test(clause) && !ownRole.test(clause)) {
      // A family member next to a company name has no business role of their own.
      const at = clause.indexOf(name), around = clause.slice(Math.max(0, at - 10), at + name.length + 18);
      if (/女儿|儿子|上小学|上学|放学|等妈妈|等爸爸|接孩子|接娃|带孩子|陪孩子/u.test(around)) return false;
      if (!/融资|投资条款|商务|业务|项目合作|联合研发|合作协议|企业贷款/u.test(clause)) return false;
    }
    return true;
  });
}

export function hasBusinessContext(text: string): boolean { return BUSINESS.test(text); }
export function commercialRelationAllowed(kind: RelationKind, quote: string, input: RelationshipCase, sourceId: string, targetId: string, projectId?: string | null): boolean {
  // Preserve the bound project's type only where its neutral token occurs.
  // Metadata alone supplies no business context, nor can names inject predicates.
  const projectIndex = input.entities.findIndex(node => node.id === projectId && node.kind === 'project');
  if (projectIndex >= 0) quote = quote.replaceAll(`⟦${projectIndex}⟧`, '【业务项目】');
  if (kind === 'introduction') {
    // Do not let another sentence mentioning a company rescue a purely social introduction.
    const clauses = quote.split(/[。；;!?！？\n]/u).filter(part => /介绍|引荐|牵线|对接|\b(?:introduc|connect)/iu.test(part));
    // A project tag alone cannot turn a social introduction into a business event.
    return clauses.some(part => BUSINESS_PURPOSE.test(part) && !PERSONAL.test(part) && !/(?:婚礼|相亲|朋友认识|交个?朋友|朋友之间|纯社交|不涉及(?:商务|业务)|与(?:商务|业务)无关)/u.test(part));
  }
  if (kind === 'lending' && PERSONAL.test(quote)) return false;
  if (kind === 'cooperation' && PERSONAL.test(quote)) return false;
  const source = input.entities.find(node => node.id === sourceId), target = input.entities.find(node => node.id === targetId);
  if (kind === 'lending' && target?.kind === 'person') return /企业融资|经营|生产周转|业务|项目|公司周转|商务|\b(?:business|corporate|working capital)\b/iu.test(quote) && !PERSONAL.test(quote);
  if (kind === 'cooperation' && source?.kind === 'person' && target?.kind === 'person') return BUSINESS.test(quote) && !PERSONAL.test(quote);
  return BUSINESS.test(quote);
}
