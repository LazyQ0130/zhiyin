# ADR 0002：M8 增量证据与帮助记录

日期：2026-10-23。采用。基线 c88cabf，迁移 202610230003_diagnosis_trust。

保留 schemaVersion 1.0、既有状态和全部业务关系，新增可选 finding.trust。模型字段只是候选，服务端独立归一。OBSERVATION 为原始表现；HYPOTHESIS 为原因推测；VERIFIED 仅限受限规则核验的具体事实，不能表示心理原因；INCONCLUSIVE 保留不足。未满足验证条件不升级。提示后或帮助来源未知的回答不能构成独立验证。

数据库仅新增5个可空字段：DiagnosisFinding.trust、DiagnosisMessage.assistance、PracticeItem.assistance、PracticeItem.hintUsedAt、PracticeSubmission.verifierDetails。旧记录不批量回填、不改写历史结论；DTO隐藏未经新机制验证的确定性措辞并显示待复核。旧独立性缺少来源时为UNKNOWN，不把缺字段视为无帮助。

迁移前实际执行 pg_dump -Fc，保存于忽略目录 .local/m8-migration-20261023T204920/before.dump；恢复到新建独立库成功。迁移前、原库迁移后、备份恢复库四类行数一致：User110、DiagnosisFinding138、DiagnosisMessage320、PracticeSubmission26。原库、恢复库、备份均保留。后续测试新增合成行，因此最终原库数量自然增加；没有删除或重置。

回退应用时保留增量列，旧版本忽略这些可空列。不得运行drop/reset或恢复覆盖当前库；需要数据恢复时先由负责人决定目标，优先新库核对后切换。该演练只证明本地备份可恢复，不证明生产灾备、物理删除或备份到期已完成。

会话回放保留实际原始历史，不因新版归一改写旧模型输出或教师盲审内容。新离线会话使用 trustPolicyVersion=M8.1，记录并重新计算实际帮助元数据；旧会话无该字段时保持原上下文哈希规则。模型Prompt版本更新为diagnosis-v1.1.0-evidence，M8没有真实模型调用。
