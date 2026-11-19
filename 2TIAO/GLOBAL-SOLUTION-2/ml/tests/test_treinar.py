import json

from ml.features import ALVOS, carregar
from ml.treinar import NIVEIS, separar_episodios, treinar


def test_treinar_writes_four_models_and_metricas(tmp_path, csv):
    destino = tmp_path / "modelos"
    treinar(csv, destino)
    for alvo in ["v15", "f15", "v30", "f30"]:
        assert (destino / f"{alvo}.txt").stat().st_size > 0
    m = json.loads((destino / "metricas.json").read_text())
    assert sorted(m["alvos"]) == sorted(ALVOS)
    for alvo in ALVOS:
        r = m["alvos"][alvo]
        assert isinstance(r["mae_modelo"], float) and r["mae_modelo"] >= 0
        assert isinstance(r["mae_persistencia"], float) and r["mae_persistencia"] >= 0
        assert r["n_teste"] > 0


def test_split_is_by_episode(tmp_path, csv):
    eps = carregar(csv)["episodio"].unique()
    treino, teste = separar_episodios(eps)
    assert len(treino) == 8 and len(teste) == 2
    assert not set(treino) & set(teste)
    assert sorted(treino + teste) == sorted(int(e) for e in eps)
    # o treino grava a mesma separação
    destino = tmp_path / "modelos"
    m = treinar(csv, destino)
    assert m["episodiosTreino"] == treino and m["episodiosTeste"] == teste
    # 200 episódios: 160 e 40
    t200, te200 = separar_episodios(range(1, 201))
    assert (len(t200), len(te200)) == (160, 40)


def test_kmeans_has_four_levels_by_speed_and_is_deterministic(tmp_path, csv):
    a, b = tmp_path / "a", tmp_path / "b"
    treinar(csv, a)
    treinar(csv, b)
    ka = json.loads((a / "kmeans.json").read_text())
    kb = json.loads((b / "kmeans.json").read_text())
    assert [c["nivel"] for c in ka["centroides"]] == NIVEIS == ["livre", "moderado", "intenso", "critico"]
    velocidades = [c["centro"][0] * ka["desvio"][0] + ka["media"][0] for c in ka["centroides"]]
    assert velocidades == sorted(velocidades, reverse=True)
    assert len(set(round(v, 3) for v in velocidades)) == 4
    assert ka["centroides"] == kb["centroides"]
    assert ka["media"] == kb["media"] and ka["desvio"] == kb["desvio"]
