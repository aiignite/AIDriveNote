"""基于 LLM 的转写润色。

Whisper（尤其是中文 small / base 模型）产出的文本常有以下问题：
    * 同音字错误
    * 没有标点——长串字符没有任何逗号/句号
    * 不通顺——说话人反复重启 / 句中自我更正
    * 太碎——每个 Whisper 分段都很短，用户希望得到按「停顿」分隔的较长段落

本服务把所有 Whisper 分段及其 (start, end) 一次性发给 LLM，要求它：
    1. 修复明显的 ASR 错误（同音字、缺失虚词）
    2. 顺句（合并碎片、去掉口误重来）
    3. 插入中文标点（，。！？）
    4. 按「停顿间隔」重新分段（≥ 阈值间隔）成较长段落
    5. 返回与源分段严格对齐的 JSON（带 start/end 时间戳）

失败是非致命的：若 LLM 调用失败或返回非法 JSON，原 Whisper 文本保持不变。
"""
from __future__ import annotations

import html
import json
import logging
import re
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.note import (
    Note,
    NoteCommonTerm,
    NoteRecording,
    NoteTranscript,
)

logger = logging.getLogger(__name__)


REFINEMENT_PROMPT = """你是中文（简体）录音转写润色员 + 同音字修复专家。任务：

═══════════════════════════════════════════
步骤 0 — **先去重**（最高优先级，Whisper 输出有重叠！）
═══════════════════════════════════════════
**Whisper 经常对同一段声学片段产生多个重叠识别结果**，特别是中长录音的滑窗解码。
你必须先把所有 segments 视为一整篇文章，找出**内容重复 / 包含 / 部分重叠**的片段，
**只保留信息最完整的一遍**，删除其冗余副本。

判定规则（按顺序检查）：
  1. 文本 A 是文本 B 的子串（A ⊂ B）→ 删除 A
  2. A 与 B 字符 Jaccard 相似度 > 0.6（去除标点和空白后）→ 保留较长的，删除短的
  3. 时间戳区间高度重叠（重叠率 > 50%）且内容主题一致 → 合并为一

示例（必须这样处理）：
  输入：
    S0 (0.0-8.3s)  "你好，请录一下当前这个音频，我们那主持者。让AI技术在开发过程中得到充分的运用。"
    S1 (6.3-8.3s)  ""（空）
    S2 (8.7-11.9s) "讓AI技術在開發過程中"
    S3 (12.1-14.1s) "得到充分的應用"
  → 去重后只剩 1 段：
    "你好，请录一下当前这个音频，我们那主持者。让AI技术在开发过程中得到充分的运用。"

不要把 S2/S3 当作"新内容"！它们是 S0 的子集。

═══════════════════════════════════════════
步骤 1 — **同音字修复**
═══════════════════════════════════════════
Whisper 中文 ASR 常出现"同音/近音"错读，请按下列常见错读表修复：

  在/再/在 → 根据上下文选「在」或「再」（「再次」≠「在次」）
  的/得/地 → 修饰动词用「地」，修饰名词用「的」，表结果用「得」
  做/作/坐 → 「做作业」「作报告」「坐下来」
  必/毕/避 → 「必须」「毕竟」「避免」
  实/是/十/时 → 根据上下文
  辩/辨/辫 → 「辩论」「辨别」「辫子」
  渡/度 → 「渡过」「速度」
  象/像 → 「现象」「好像」
  须/需 → 「必须」「需要」
  功/工/公 → 「功夫」「工作」「公开」
  记/纪/计 → 「记忆」「纪念」「计算」
  技/计 → 「技术」「计算」
  测试/测验 → 「软件测试」「随堂测验」
  系统/系通/希统 → 「系统」（Whisper 常见错）
  录音/录影/路引 → 「录音」
  转写/转擕 → 「转写」
  笔记/笔迹 → 「笔记」
  项目/项木/相目 → 「项目」
  模板/模版/模枋 → 「模板」
  数据/数具/书据 → 「数据」
  软件/软体/软见 → 「软件」
  信息/资讯/资迅 → 「信息」
  优先级/优先集 → 「优先级」
  截止/截此/截至 → 「截止日期」

═══════════════════════════════════════════
步骤 2 — **整篇一起看**（不要按单句）
═══════════════════════════════════════════
去重后，请把剩余片段视为**一整篇文章**：
  • 读完全部
  • 理解整体主题
  • 然后再开始逐段改写

═══════════════════════════════════════════
步骤 3 — **通顺性优化**
═══════════════════════════════════════════
  • 合并断句
  • 去除无意义语气词（嗯、啊、那个那个、这个这个）
  • 修正口误和自我更正
  • 补全缺失的主语和宾语
  • 让每段读起来像正式文本

═══════════════════════════════════════════
步骤 4 — **加标点**
═══════════════════════════════════════════
为通顺后的中文添加合适的逗号、句号、问号、感叹号。

═══════════════════════════════════════════
步骤 5 — **重组段落**（沉默 ≥3.0 秒 = 段边界）
═══════════════════════════════════════════
**严格按"沉默间隔 + 语义主题"分段**（去重之后操作）：
  • 原文里两个相邻 segments 间隔 ≥ 3.0 秒 → 优先分段
  • 间隔 < 3.0 秒 → 合并为同一段，除非合并后超过 300 字
  • 沉默 ≥ 4.0 秒即使字数不足也要分段
  • **每段长度 80~300 字**（6 分钟录音预期 8~15 段，禁止逐句分段）
  • 按讨论主题组织，不要为凑段数而拆句
  • **禁止为了凑数而把一句话拆成多段**（这是错误做法）

═══════════════════════════════════════════
步骤 6 — **保留时间戳**
═══════════════════════════════════════════
  • 每段必须带 start（秒，0.1 秒精度）和 end（秒，0.1 秒精度）
  • start/end 必须是输入 segments 中某个 segment 的 start_time/end_time
  • **不准发明新时间**

═══════════════════════════════════════════
步骤 7 — **强制简体中文输出**（硬性要求）
═══════════════════════════════════════════
  • 所有正文必须**简体中文**，**严禁**繁体字
  • 若输入混繁简，**全部转换为简体**
  • 逐字符对照表（你必须严格执行）：
      我們→我们  資訊→信息  軟體→软件  讓→让  開→开
      發→发      過→过      應→应      樣→样  學→学
      機→机      電→电      專→专      類→类  訊→讯
      檔→档      畫→画      點→点      線→线  體→体
      車→车      長→长      龍→龙      師→师  處→处
  • 输出前自检：如果你的输出包含任意一个上述繁体字，整段重写

═══════════════════════════════════════════
输入是 JSON 数组：每个元素形如
  {"i": 0, "start": 0.0, "end": 3.5, "text": "..."}

═══════════════════════════════════════════
输出必须是合法 JSON 数组，不要任何解释文字：
[
  {"start": 0.0, "end": 3.5, "text": "修正并加标点后的简体段落，80-300 字。"},
  {"start": 4.5, "end": 8.0, "text": "下一段..."}
]

只输出 JSON。"""


# ── 后处理：zhconv + 港台→大陆用法映射 + 字符级兜底 ──────────────────

_TW_TO_CN_OVERRIDES: dict[str, str] = {
    # 港台/台湾正体 → 大陆简体（覆盖 zhconv 输出仍残留的港台用词）
    "软体": "软件",
    "资讯": "信息",
    "网路": "网络",
    "伺服器": "服务器",
    "资料": "数据",
    "资料库": "数据库",
    "档案": "文件",
    "档桉": "文件",
    "阵列": "数组",
    "物件": "对象",
    "预设": "默认",
    "解析度": "分辨率",
    "讯息": "消息",
    "当机": "宕机",
    "视讯": "视频",
    "连结": "连接",
    "专案": "项目",
    "专桉": "项目",
    "音讯": "音频",
    "硬体": "硬件",
    "介面": "界面",
    "字串": "字符串",
    "变数": "变量",
    "函式": "函数",
    "程式": "程序",
    "应用程式": "应用程序",
    "汇入": "导入",
    "汇出": "导出",
    "载入": "加载",
    "侦错": "调试",
    "设定": "设置",
    "丛集": "集群",
    "记忆体": "内存",
    "硬碟": "硬盘",
    "滑鼠": "鼠标",
    "萤幕": "屏幕",
    "网域": "域名",
    "使用者": "用户",
    "登入": "登录",
}


_DEFAULT_DOMAIN_TERMS = [
    "项目", "议题", "行动项", "负责人", "截止日期", "风险", "问题",
    "设计评审", "底稿材料", "定位销", "工装夹具", "假设", "系数", "数据",
    "材料", "设备", "产线", "软件", "硬件", "接口", "需求", "测试", "验证",
]

_SENTENCE_ENDINGS = "。！？!?"


def _merge_settings() -> tuple[int, int, float, float]:
    """从配置读取段落合并阈值。"""
    from app.config import get_settings
    s = get_settings()
    return (
        int(s.NOTE_MERGE_MIN_PARAGRAPH_CHARS),
        int(s.NOTE_MERGE_MAX_PARAGRAPH_CHARS),
        float(s.NOTE_MERGE_SOFT_PAUSE_SECONDS),
        float(s.NOTE_MERGE_HARD_PAUSE_SECONDS),
    )


# 逐字符 繁体→简体 兜底映射。覆盖 zhconv 遗漏 / 导入失败时剩下的高频繁体字。
# 仅收录 Whisper + LLM 在录音场景中实际产生过的字，保持精简以避免误伤同形字。
_TRAD_TO_SIMP_FALLBACK: dict[str, str] = {
    "讓": "让", "開": "开", "發": "发", "過": "过", "應": "应",
    "樣": "样", "學": "学", "機": "机", "電": "电", "專": "专",
    "類": "类", "訊": "讯", "檔": "档", "畫": "画", "點": "点",
    "線": "线", "體": "体", "車": "车", "長": "长", "龍": "龙",
    "師": "师", "處": "处", "頭": "头", "節": "节", "親": "亲",
    "謝": "谢", "語": "语", "話": "话", "說": "说", "請": "请",
    "記": "记", "時": "时", "間": "间", "問": "问", "題": "题",
    "答": "答", "選": "选", "擇": "择", "場": "场", "個": "个",
    "們": "们", "從": "从", "對": "对", "當": "当", "麼": "么",
    "為": "为", "還": "还", "這": "这", "進": "进",
    "門": "门", "關": "关", "單": "单", "買": "买", "賣": "卖",
    "結": "结", "構": "构", "軟": "软", "資": "资",
    "網": "网", "絡": "络", "實": "实", "現": "现", "變": "变",
    "換": "换", "預": "预", "設": "设", "傳": "传", "輸": "输",
    "連": "连", "創": "创", "業": "业", "產": "产", "經": "经",
    "營": "营", "務": "务", "術": "术", "藝": "艺", "團": "团",
    "隊": "队", "組": "组", "織": "织", "紙": "纸", "筆": "笔",
    "寫": "写", "讀": "读", "聲": "声", "樂": "乐", "觀": "观",
    "眾": "众", "參": "参", "與": "与", "決": "决", "議": "议",
    "證": "证", "據": "据", "滿": "满", "確": "确", "認": "认",
    "識": "识", "兒": "儿", "歲": "岁", "夢": "梦", "飛": "飞",
    "魚": "鱼", "鳥": "鸟", "黃": "黄", "頁": "页", "區": "区",
    "塊": "块", "帶": "带", "條": "条", "標": "标", "準": "准",
    "練": "练", "習": "习", "響": "响", "導": "导",
    "報": "报", "價": "价", "質": "质", "檢": "检",
    "驗": "验", "試": "试", "監": "监", "測": "测", "屬": "属",
    "總": "总", "係": "系", "則": "则",
    "數": "数", "兩": "两", "該": "该", "慮": "虑", "會": "会",
    "講": "讲", "聽": "听", "嗎": "吗",
}


def _simplify_chinese(text: str) -> str:
    """三级管道强制输出标准简体中文：
    1) zhconv.convert(text, "zh-cn")  ← 字符级转换主力
    2) _TW_TO_CN_OVERRIDES            ← 港台/台湾用词 → 大陆用词
    3) _TRAD_TO_SIMP_FALLBACK         ← 字符级兜底（zhconv 缺失时）
    导入失败时记录 warning，不再静默吞错。
    """
    if not text:
        return text
    try:
        import zhconv
        text = zhconv.convert(text, "zh-cn")
    except ImportError:
        logger.warning(
            "zhconv not installed; falling back to character-level dict only. "
            "Install zhconv>=1.4.3 for full traditional-to-simplified conversion."
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("zhconv.convert failed (%s); using fallback dict", exc)
    for tw, cn in _TW_TO_CN_OVERRIDES.items():
        if tw in text:
            text = text.replace(tw, cn)
    # 字符级兜底：用 str.translate 一次性替换，比循环 replace 快
    if _TRAD_TO_SIMP_FALLBACK:
        text = text.translate(str.maketrans(_TRAD_TO_SIMP_FALLBACK))
    for tw, cn in _TW_TO_CN_OVERRIDES.items():
        if tw in text:
            text = text.replace(tw, cn)
    return text


@dataclass(slots=True)
class RefinedSegment:
    """一段润色后的转写文本。

    属性说明：
        start/end: 起止时间（秒）。
        text: 润色后的文本。
    """

    start: float
    end: float
    text: str

    def to_dict(self) -> dict[str, Any]:
        """转为带 0.1s 精度时间戳的字典。"""
        return {"start": round(self.start, 1), "end": round(self.end, 1), "text": self.text}


@dataclass(slots=True)
class TranscriptRefinementContext:
    """润色时投喂给 LLM 的上下文。

    属性说明：
        note_title: 所属笔记标题。
        note_type: 笔记类型。
        note_context: 笔记描述/正文等附加上下文文本。
        terms: 常用词库词条（含同音/易错写法提示）。
    """

    note_title: str | None = None
    note_type: str | None = None
    note_context: str | None = None
    terms: list[str] | None = None


def _strip_rich_text(text: str | None) -> str:
    """去掉富文本标签并归一化空白，最后转简体。"""
    if not text:
        return ""
    cleaned = html.unescape(text.replace("&nbsp;", " "))
    cleaned = re.sub(r"<[^>]+>", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return _simplify_chinese(cleaned)


def _context_terms(context: TranscriptRefinementContext | None) -> list[str]:
    """汇总上下文与常用词库词条（去重，最多 40 个）。"""
    terms: list[str] = []
    seen: set[str] = set()
    # 常用词投喂 AI：用户维护词条优先
    for term in context.terms or []:
        t = (term or "").strip()
        if t and t not in seen:
            terms.append(t)
            seen.add(t)
    source = " ".join(
        part for part in [
            context.note_title if context else None,
            context.note_type if context else None,
            _strip_rich_text(context.note_context) if context else None,
        ]
        if part
    )
    context_text = _strip_rich_text(context.note_context) if context else ""
    for term in _DEFAULT_DOMAIN_TERMS:
        if term not in seen:
            terms.append(term)
            seen.add(term)
    for chunk in re.split(r"[，,。；;、\s]+", context_text):
        chunk = chunk.strip("：:（）()[]【】")
        if 2 <= len(chunk) <= 24 and chunk not in seen:
            terms.append(chunk)
            seen.add(chunk)
    for token in re.findall(r"[A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]{2,12}", source):
        token = token.strip("，。；、：:（）()[]【】")
        if token and token not in seen:
            terms.append(token)
            seen.add(token)
        if len(terms) >= 40:
            break
    return terms


def _build_context_prompt(context: TranscriptRefinementContext | None) -> str:
    """把上下文构造为提示词片段。"""
    if context is None:
        return ""
    context_text = _strip_rich_text(context.note_context)
    lines = ["笔记上下文："]
    if context.note_title:
        lines.append(f"- 笔记标题：{_simplify_chinese(context.note_title)}")
    if context.note_type:
        lines.append(f"- 笔记类型：{_simplify_chinese(context.note_type)}")
    if context_text:
        lines.append(f"- 笔记描述：{context_text}")
    terms = _context_terms(context)
    if terms:
        lines.append("- 术语提示（常用词库 + 上下文提取，注意同音词）：")
        lines.append("  " + "、".join(terms))
    lines.append("请优先按照笔记上下文和术语提示理解同音词，不要凭空引入上下文外的专有词。")
    return "\n".join(lines)


def _build_user_prompt(
    segments: list[NoteTranscript],
    *,
    context: TranscriptRefinementContext | None = None,
) -> str:
    """构造发送给 LLM 的用户提示词。"""
    items = [
        {
            "i": idx,
            "start": round(float(s.start_time), 1),
            "end": round(float(s.end_time), 1),
            "text": _simplify_chinese(s.text or ""),
        }
        for idx, s in enumerate(segments)
    ]
    parts = []
    context_prompt = _build_context_prompt(context)
    if context_prompt:
        parts.append(context_prompt)
    parts.append("输入 segments（JSON）：\n" + json.dumps(items, ensure_ascii=False))
    return "\n\n".join(parts)


def _extract_json(text: str) -> str | None:
    """从模型输出中提取 JSON 数组字符串。"""
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```\s*$", "", cleaned)
    if cleaned.startswith("[") and cleaned.endswith("]"):
        return cleaned
    start = cleaned.find("[")
    if start < 0:
        return None
    depth = 0
    for i in range(start, len(cleaned)):
        ch = cleaned[i]
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return cleaned[start : i + 1]
    return None


def _fallback_segments(segments: list[NoteTranscript]) -> list[RefinedSegment]:
    """LLM 失败时，仍提供可读的简体段落。"""
    out: list[RefinedSegment] = []
    for s in segments:
        text = (s.text or "").strip()
        if not text:
            continue
        text = _simplify_chinese(text)
        out.append(RefinedSegment(start=float(s.start_time), end=float(s.end_time), text=text))
    return _merge_short_refined_segments(out)


def _content_len(text: str) -> int:
    """统计去除标点空白后的有效字符数。"""
    return len(re.sub(r"[\s，。！？!?；;、,.]", "", text or ""))


def _ensure_sentence_end(text: str) -> str:
    """确保文本以句末标点结尾。"""
    stripped = (text or "").strip()
    if not stripped:
        return stripped
    if stripped[-1] not in _SENTENCE_ENDINGS:
        return stripped + "。"
    return stripped


def _join_segment_text(left: str, right: str) -> str:
    """按标点与长度选择合适的分隔符拼接两段文本。"""
    left = (left or "").strip()
    right = (right or "").strip()
    if not left:
        return right
    if not right:
        return left
    if left[-1] in "，、；;：:":
        return left + right
    if left[-1] in _SENTENCE_ENDINGS:
        return left + right
    separator = "，" if _content_len(left) <= 12 or _content_len(right) <= 16 else "。"
    return left + separator + right


def _merge_short_refined_segments(
    refined: list[RefinedSegment],
    *,
    min_chars: int | None = None,
    max_chars: int | None = None,
    soft_pause_seconds: float | None = None,
    hard_pause_seconds: float | None = None,
) -> list[RefinedSegment]:
    """规则层的长段落合并（LLM 润色前后各执行一次）。"""
    cfg_min, cfg_max, cfg_soft, cfg_hard = _merge_settings()
    min_chars = cfg_min if min_chars is None else min_chars
    max_chars = cfg_max if max_chars is None else max_chars
    soft_pause_seconds = cfg_soft if soft_pause_seconds is None else soft_pause_seconds
    hard_pause_seconds = cfg_hard if hard_pause_seconds is None else hard_pause_seconds
    if not refined:
        return []
    ordered = sorted(refined, key=lambda item: (item.start, item.end))
    current: RefinedSegment | None = None
    merged: list[RefinedSegment] = []

    def flush() -> None:
        nonlocal current
        if current is not None and current.text.strip():
            merged.append(
                RefinedSegment(
                    start=round(current.start, 1),
                    end=round(current.end, 1),
                    text=_ensure_sentence_end(_simplify_chinese(current.text)),
                )
            )
        current = None

    for item in ordered:
        text = _simplify_chinese(item.text).strip()
        if not text:
            continue
        candidate = RefinedSegment(start=float(item.start), end=float(item.end), text=text)
        if current is None:
            current = candidate
            continue

        gap = candidate.start - current.end
        combined_text = _join_segment_text(current.text, candidate.text)
        combined_len = _content_len(combined_text)
        current_short = _content_len(current.text) < min_chars
        candidate_short = _content_len(candidate.text) < min_chars
        can_merge = combined_len <= max_chars and gap < hard_pause_seconds
        should_merge = can_merge and (
            gap < soft_pause_seconds or current_short or candidate_short
        )
        if should_merge:
            current = RefinedSegment(
                start=current.start,
                end=max(current.end, candidate.end),
                text=combined_text,
            )
        else:
            flush()
            current = candidate
    flush()
    return merged


def segments_to_refined(segments: list[NoteTranscript]) -> list[RefinedSegment]:
    """把数据库/ORM 分段转换为 RefinedSegment 列表。"""
    out: list[RefinedSegment] = []
    for s in segments:
        text = (s.text or "").strip()
        if not text:
            continue
        out.append(
            RefinedSegment(
                start=float(s.start_time),
                end=float(s.end_time),
                text=_simplify_chinese(text),
            )
        )
    return out


def merge_refined_segments(refined: list[RefinedSegment]) -> list[RefinedSegment]:
    """规则层长段落合并（LLM 前后通用）。"""
    return _merge_short_refined_segments(refined)


def merge_whisper_segments(segments: list[Any]) -> list[Any]:
    """入库前合并原始 Whisper 分段。"""
    if not segments:
        return []
    refined = [
        RefinedSegment(
            start=float(getattr(s, "start", 0)),
            end=float(getattr(s, "end", 0)),
            text=_simplify_chinese(str(getattr(s, "text", "") or "").strip()),
        )
        for s in segments
        if str(getattr(s, "text", "") or "").strip()
    ]
    merged = merge_refined_segments(refined)
    out: list[Any] = []
    for item in merged:
        out.append(
            type(segments[0])(
                start=round(item.start, 3),
                end=round(item.end, 3),
                text=item.text,
                confidence=getattr(segments[0], "confidence", None),
                speaker_label=None,
            )
        )
    return out


class TranscriptRefinementService:
    """基于 LLM 的转写润色器。尽力而为，从不抛异常。"""

    def __init__(self, *, provider: str | None = None, model: str | None = None) -> None:
        """初始化：记录可选的 provider/model 覆盖值。

        属性说明：
            _provider: 显式 provider（本项目由 LLMRouter 解析，这里仅留存）。
            _model: 显式模型名；为空则用 ``NOTE_AI_MODEL``。
        """
        from app.config import get_settings
        settings = get_settings()
        self._provider = provider
        self._model = model or settings.NOTE_AI_MODEL or None

    async def refine(
        self,
        segments: list[NoteTranscript],
        *,
        context: TranscriptRefinementContext | None = None,
        db: AsyncSession | None = None,
    ) -> list[RefinedSegment]:
        """对分段做一次润色；失败时保留原始文本。"""
        if not segments:
            return []

        pre_merged = merge_refined_segments(segments_to_refined(segments))
        # 极短转写不值得送 LLM（成本/延迟/失败率高）
        total_chars = sum(len(s.text or "") for s in pre_merged)
        if total_chars < 6:
            return pre_merged

        try:
            # LLM 输入用轻量 namespace，避免 ORM 依赖
            llm_input = [
                type("Seg", (), {
                    "start_time": s.start,
                    "end_time": s.end,
                    "text": s.text,
                    "speaker_label": None,
                })()
                for s in pre_merged
            ]
            refined = await self._call_llm(llm_input, context=context, db=db)  # type: ignore[reportArgumentType]  类型修复
        except Exception as exc:  # noqa: BLE001
            logger.warning("transcript refinement LLM call failed: %s", exc)
            return pre_merged

        if not refined:
            return pre_merged

        # 用原始 segment 的 (start, end) 兜底 + 时间戳合法化
        anchors = [(s.start, s.end, s.text) for s in pre_merged]
        aligned = _align_refined_with_anchors(refined, anchors)
        return merge_refined_segments(aligned)

    async def _call_llm(
        self,
        segments: list[NoteTranscript],
        *,
        context: TranscriptRefinementContext | None = None,
        db: AsyncSession | None = None,
    ) -> list[RefinedSegment]:
        """调用 LLM 并解析其 JSON 输出为 RefinedSegment。"""
        from app.services.note.recording.llm_dispatch import dispatch_llm

        raw, _model_name = await dispatch_llm(
            db,
            system_prompt=REFINEMENT_PROMPT,
            user_prompt=_build_user_prompt(segments, context=context),
            model=self._model,
            max_tokens=4000,
            temperature=0.2,
        )
        json_text = _extract_json(raw)
        if not json_text:
            logger.warning("refinement: model returned non-JSON: %r", raw[:200])
            return []
        try:
            data = json.loads(json_text)
        except json.JSONDecodeError as exc:
            logger.warning("refinement: JSON parse failed: %s — %r", exc, raw[:200])
            return []
        if not isinstance(data, list):
            return []
        out: list[RefinedSegment] = []
        for item in data:
            if not isinstance(item, dict):
                continue
            try:
                start = float(item.get("start"))  # type: ignore[reportArgumentType]  类型修复
                end = float(item.get("end"))  # type: ignore[reportArgumentType]  类型修复
            except (TypeError, ValueError):
                continue
            if end <= start:
                continue
            text = str(item.get("text") or "").strip()
            if not text:
                continue
            text = _simplify_chinese(text)
            out.append(RefinedSegment(start=start, end=end, text=text))
        return out


def _align_refined_with_anchors(
    refined: list[RefinedSegment],
    anchors: list[tuple[float, float, str]],
) -> list[RefinedSegment]:
    """若润色分段的时间戳与任一锚点不匹配，则吸附到最近锚点（2 秒内）。"""
    aligned: list[RefinedSegment] = []
    for r in refined:
        nearest_start = min((s for s, _, _ in anchors), key=lambda s: abs(r.start - s))
        nearest_end = min((e for _, e, _ in anchors), key=lambda e: abs(r.end - e))
        start = nearest_start if abs(r.start - nearest_start) <= 2.0 else r.start
        end = nearest_end if abs(r.end - nearest_end) <= 2.0 else r.end
        if end <= start:
            end = r.end
        aligned.append(RefinedSegment(start=start, end=end, text=r.text))
    return aligned


async def _load_refinement_context(
    db: AsyncSession,
    recording_id: Any,
) -> TranscriptRefinementContext | None:
    """加载录音关联笔记与常用词库，构造润色上下文。"""
    stmt = (
        select(NoteRecording, Note)
        .outerjoin(Note, NoteRecording.note_id == Note.id)
        .where(
            NoteRecording.id == recording_id,
            NoteRecording.is_deleted == False,  # noqa: E712
        )
    )
    row = (await db.execute(stmt)).first()
    if row is None:
        return None
    _recording, note = row

    # 常用词投喂 AI：加载启用的常用词库词条（term + alias）
    terms: list[str] = []
    terms_result = await db.execute(
        select(NoteCommonTerm)
        .where(
            NoteCommonTerm.is_deleted == False,  # noqa: E712
            NoteCommonTerm.is_enabled == True,  # noqa: E712
        )
        .order_by(NoteCommonTerm.usage_count.desc(), NoteCommonTerm.created_at.asc())
    )
    for term_row in terms_result.scalars().all():
        terms.append(term_row.term)
        if term_row.alias:
            for alias in re.split(r"[,，;；]", term_row.alias):
                alias = alias.strip()
                if alias:
                    terms.append(alias)

    return TranscriptRefinementContext(
        note_title=(note.title if note else None),
        note_type=(note.note_type if note else None),
        note_context=(note.description if note else None),
        terms=terms,
    )


async def apply_refinement_to_recording(
    db: AsyncSession,
    recording_id: Any,
    *,
    provider: str | None = None,
    model: str | None = None,
) -> int:
    """重新拉取录音分段并把润色文本写回 ``text`` 列（替换原始 Whisper 文本）。

    返回被润色的分段数量。
    """
    import uuid

    stmt = (
        select(NoteTranscript)
        .where(
            NoteTranscript.recording_id == recording_id,
            NoteTranscript.is_deleted == False,  # noqa: E712
        )
        .order_by(NoteTranscript.segment_index.asc())
    )
    rows = list((await db.execute(stmt)).scalars().all())
    if not rows:
        return 0

    svc = TranscriptRefinementService(provider=provider, model=model)
    context = await _load_refinement_context(db, recording_id)
    refined = await svc.refine(rows, context=context, db=db)
    if not refined:
        return 0

    template = rows[0]
    language = template.language
    confidence = template.confidence

    for row in rows:
        row.is_deleted = True

    for idx, seg in enumerate(refined):
        text = (seg.text or "").strip()
        if not text:
            continue
        db.add(
            NoteTranscript(
                id=uuid.uuid4(),
                recording_id=recording_id,
                segment_index=idx,
                start_time=seg.start,
                end_time=seg.end,
                speaker_label=None,
                text=text,
                confidence=confidence,
                language=language,
                is_deleted=False,
            )
        )

    try:
        from app.services.note.recording.chapterization_service import (
            apply_chapters_and_keywords,
        )
        await apply_chapters_and_keywords(db, recording_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("post-refinement chapterization failed: %s", exc)

    await db.commit()
    return len(refined)